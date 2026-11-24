const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const app = express();
app.disable("x-powered-by");
app.use(express.json({limit:"20kb"}));
app.use((req,res,next)=>{
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("X-Frame-Options","DENY");
  res.setHeader("Referrer-Policy","no-referrer");
  res.setHeader("Content-Security-Policy","default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if(req.path.startsWith("/api/")) res.setHeader("Cache-Control","no-store");
  next();
});

// Basic per-process throttling for sensitive unauthenticated endpoints.
// Use a shared store (for example Redis) if deploying multiple app instances.
const attempts=new Map();
function throttle(max,windowMs){
 return (req,res,next)=>{
  const key=req.ip+"|"+req.path, now=Date.now();
  let entry=attempts.get(key);
  if(!entry||now-entry.start>=windowMs){entry={start:now,count:0};attempts.set(key,entry);}
  entry.count++;
  if(entry.count>max)return res.status(429).json({error:"Too many attempts. Please wait and try again."});
  next();
 };
}
setInterval(()=>{
 const now=Date.now();
 for(const [key,value] of attempts)if(now-value.start>=15*60*1000)attempts.delete(key);
 db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(now);
},15*60*1000).unref();
const dbFile=process.env.DATABASE_FILE||"./data/playzone.sqlite";
fs.mkdirSync(path.dirname(dbFile),{recursive:true});
const db=new Database(dbFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
 display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('admin','master','player')),
 parent_id INTEGER REFERENCES users(id), balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0),
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS master_limits(
 master_id INTEGER PRIMARY KEY REFERENCES users(id), allocated INTEGER NOT NULL CHECK(allocated>=0),
 available INTEGER NOT NULL CHECK(available>=0 AND available<=allocated)
);
CREATE TABLE IF NOT EXISTS ledger(
 id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER NOT NULL REFERENCES users(id),
 from_user_id INTEGER REFERENCES users(id), to_user_id INTEGER REFERENCES users(id),
 amount INTEGER NOT NULL CHECK(amount>0), action TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions(
 token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_main_admin ON users(role) WHERE role='admin';
CREATE INDEX IF NOT EXISTS users_parent_idx ON users(parent_id);
CREATE INDEX IF NOT EXISTS ledger_actor_idx ON ledger(actor_id,id DESC);
`);

if(process.env.NODE_ENV==="production" && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length<32))
  throw new Error("Set SESSION_SECRET to at least 32 characters in production.");
const cookie="pz_session";
const hash=s=>crypto.createHash("sha256").update(s).digest("hex");
const passwordHash=(p,salt=crypto.randomBytes(16).toString("hex"))=>salt+":"+crypto.scryptSync(p,salt,64).toString("hex");
function passwordOK(p,stored){
  const [salt,hex]=String(stored).split(":");
  const a=crypto.scryptSync(p,salt,64), b=Buffer.from(hex,"hex");
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}
function getCookie(req){
  const part=(req.headers.cookie||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(cookie+"="));
  return part?decodeURIComponent(part.slice(cookie.length+1)):null;
}
function sessionCookie(res,token){
  res.cookie(cookie,token,{httpOnly:true,sameSite:"strict",secure:process.env.NODE_ENV==="production",path:"/",maxAge:43200000});
}
function auth(req,res,next){
  const token=getCookie(req);
  if(!token)return res.status(401).json({error:"Please sign in."});
  const u=db.prepare(`SELECT u.id,u.username,u.display_name,u.role,u.parent_id,u.balance,u.active
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?
    AND (u.role<>'player' OR EXISTS(SELECT 1 FROM users p WHERE p.id=u.parent_id AND p.active=1))`).get(hash(token),Date.now());
  if(!u||!u.active)return res.status(401).json({error:"Session expired or account disabled."});
  req.user=u;next();
}
const roles=(...allowed)=>(req,res,next)=>allowed.includes(req.user.role)?next():res.status(403).json({error:"Not allowed."});
const usernameOK=s=>typeof s==="string"&&/^[A-Za-z0-9_.-]{3,24}$/.test(s);
const passwordOKFormat=s=>typeof s==="string"&&s.length>=10&&s.length<=200;
const intOK=n=>Number.isSafeInteger(n)&&n>0&&n<=100000000;
const safe=u=>({id:u.id,username:u.username,displayName:u.display_name,role:u.role,parentId:u.parent_id,balance:u.balance,active:!!u.active});
function audit(actor,from,to,amount,action,note=""){
 db.prepare("INSERT INTO ledger(actor_id,from_user_id,to_user_id,amount,action,note) VALUES(?,?,?,?,?,?)")
 .run(actor,from||null,to||null,amount,action,String(note).slice(0,160));
}
function loginSession(id,res){
 const token=crypto.randomBytes(32).toString("base64url");
 db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").run(hash(token),id,Date.now()+43200000);
 sessionCookie(res,token);
}
const adminExists=()=>!!db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get();

app.get("/api/health",(req,res)=>res.json({ok:true,app:"PLAYZONE"}));
app.get("/api/setup-status",(req,res)=>res.json({needsAdmin:!adminExists()}));
app.post("/api/setup",throttle(5,15*60*1000),(req,res)=>{
 const {setupKey,username,displayName,password}=req.body||{};
 if(adminExists())return res.status(409).json({error:"Main Admin already exists."});
 if(!process.env.INITIAL_SETUP_KEY || setupKey!==process.env.INITIAL_SETUP_KEY)return res.status(403).json({error:"Invalid setup key. Configure INITIAL_SETUP_KEY in the Codespace environment."});
 if(!usernameOK(username)||!passwordOKFormat(password)||typeof displayName!=="string"||displayName.trim().length<2)
  return res.status(400).json({error:"Enter a valid username, display name and password of at least 10 characters."});
 try{
  const r=db.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES(?,?,?,'admin')")
   .run(username,displayName.trim().slice(0,60),passwordHash(password));
  db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('reserve','1000000')").run();
  loginSession(r.lastInsertRowid,res);
  res.status(201).json({user:safe(db.prepare("SELECT * FROM users WHERE id=?").get(r.lastInsertRowid))});
 }catch(e){res.status(400).json({error:"Could not create Main Admin. Username may already exist."});}
});
app.post("/api/login",throttle(10,15*60*1000),(req,res)=>{
 const {username,password}=req.body||{};
 const u=db.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE").get(String(username||""));
 if(!u||!u.active||(u.role==="player"&&!db.prepare("SELECT active FROM users WHERE id=?").get(u.parent_id)?.active)||typeof password!=="string"||!passwordOK(password,u.password_hash))return res.status(401).json({error:"Invalid username or password."});
 loginSession(u.id,res);res.json({user:safe(u)});
});
app.post("/api/logout",auth,(req,res)=>{
 const t=getCookie(req);db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash(t));
 res.clearCookie(cookie,{httpOnly:true,sameSite:"strict",secure:process.env.NODE_ENV==="production",path:"/"});
 res.json({ok:true});
});
app.get("/api/me",auth,(req,res)=>res.json({user:safe(db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id))}));

app.post("/api/admin/masters",auth,roles("admin"),(req,res)=>{
 const {username,displayName,password,allocation}=req.body||{};
 if(!usernameOK(username)||!passwordOKFormat(password)||typeof displayName!=="string"||displayName.trim().length<2||!Number.isSafeInteger(allocation)||allocation<0)
  return res.status(400).json({error:"Invalid master details or allocation."});
 const reserve=Number(db.prepare("SELECT value FROM settings WHERE key='reserve'").get()?.value||0);

 try{
  const id=db.transaction(()=>{
   const r=db.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES(?,?,?,'master')")
    .run(username,displayName.trim().slice(0,60),passwordHash(password));
   db.prepare("INSERT INTO master_limits(master_id,allocated,available) VALUES(?,?,?)").run(r.lastInsertRowid,allocation,allocation);
   if(allocation)audit(req.user.id,null,r.lastInsertRowid,allocation,"MASTER_ALLOCATION","Initial master quota");
   return r.lastInsertRowid;
  })();
  res.status(201).json({user:safe(db.prepare("SELECT * FROM users WHERE id=?").get(id))});
 }catch(e){res.status(400).json({error:"Could not create master. Username may already exist."});}
});
app.post("/api/admin/masters/:id/allocation",auth,roles("admin"),(req,res)=>{
 const id=Number(req.params.id),amount=req.body?.amount;
 if(!Number.isInteger(id)||!Number.isSafeInteger(amount)||amount===0)return res.status(400).json({error:"Enter a non-zero whole number."});
 const limit=db.prepare("SELECT * FROM master_limits WHERE master_id=?").get(id);
 if(!limit)return res.status(404).json({error:"Master not found."});
 try{
  db.transaction(()=>{
   const reserve=Number(db.prepare("SELECT value FROM settings WHERE key='reserve'").get().value);
   if(limit.available+amount<0||limit.allocated+amount<0)throw Error("Cannot recall points already distributed.");
   db.prepare("UPDATE master_limits SET allocated=allocated+?,available=available+? WHERE master_id=?").run(amount,amount,id);
   audit(req.user.id,null,id,Math.abs(amount),amount>0?"MASTER_ALLOCATION":"MASTER_RECALL","Admin quota adjustment");
  })();
  res.json({ok:true});
 }catch(e){res.status(400).json({error:e.message});}
});
app.post("/api/players",auth,roles("admin","master"),(req,res)=>{
 const {username,displayName,password,startingBalance=0,masterId}=req.body||{};
 if(!usernameOK(username)||!passwordOKFormat(password)||typeof displayName!=="string"||displayName.trim().length<2||!Number.isSafeInteger(startingBalance)||startingBalance<0)
  return res.status(400).json({error:"Invalid player details."});
 const parent=req.user.role==="master"?req.user.id:Number(masterId);
 const master=db.prepare("SELECT u.id,l.available FROM users u JOIN master_limits l ON l.master_id=u.id WHERE u.id=? AND u.role='master' AND u.active=1").get(parent);
 if(!master)return res.status(400).json({error:"Select a valid active master."});
 if(startingBalance>master.available)return res.status(400).json({error:"Starting points exceed available master quota."});
 try{
  const id=db.transaction(()=>{
   const r=db.prepare("INSERT INTO users(username,display_name,password_hash,role,parent_id,balance) VALUES(?,?,?,'player',?,?)")
    .run(username,displayName.trim().slice(0,60),passwordHash(password),parent,startingBalance);
   if(startingBalance){
    db.prepare("UPDATE master_limits SET available=available-? WHERE master_id=?").run(startingBalance,parent);
    audit(req.user.id,null,r.lastInsertRowid,startingBalance,"PLAYER_CREDIT","Starting points");
   }
   return r.lastInsertRowid;
  })();
  res.status(201).json({user:safe(db.prepare("SELECT * FROM users WHERE id=?").get(id))});
 }catch(e){res.status(400).json({error:"Could not create player. Username may already exist."});}
});
app.post("/api/players/:id/points",auth,roles("admin","master"),(req,res)=>{
 const id=Number(req.params.id),amount=req.body?.amount,note=req.body?.note||"";
 if(!Number.isInteger(id)||!Number.isSafeInteger(amount)||amount===0||Math.abs(amount)>100000000)return res.status(400).json({error:"Enter a non-zero whole-number adjustment."});
 const p=db.prepare("SELECT * FROM users WHERE id=? AND role='player' AND active=1").get(id);
 if(!p)return res.status(404).json({error:"Player not found."});
 if(req.user.role==="master"&&p.parent_id!==req.user.id)return res.status(403).json({error:"You can only manage your own players."});
 const lim=db.prepare("SELECT * FROM master_limits WHERE master_id=?").get(p.parent_id);
 try{
  db.transaction(()=>{
   if(amount>0){
    if(amount>lim.available)throw Error("Insufficient master allocation.");
    db.prepare("UPDATE master_limits SET available=available-? WHERE master_id=?").run(amount,p.parent_id);
    db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(amount,id);
    audit(req.user.id,null,id,amount,"PLAYER_CREDIT",note);
   }else{
    const debit=-amount;if(debit>p.balance)throw Error("Player balance is too low.");
    db.prepare("UPDATE users SET balance=balance-? WHERE id=?").run(debit,id);
    db.prepare("UPDATE master_limits SET available=available+? WHERE master_id=?").run(debit,p.parent_id);
    audit(req.user.id,id,null,debit,"PLAYER_DEBIT",note);
   }
  })();res.json({ok:true});
 }catch(e){res.status(400).json({error:e.message});}
});
// Account administration. Main Admin can manage all accounts; Masters are
// restricted to their own players. Disabling an account revokes its sessions.
app.post("/api/accounts/:id/status",auth,roles("admin","master"),(req,res)=>{
 const id=Number(req.params.id), active=req.body?.active;
 if(!Number.isInteger(id)||typeof active!=="boolean")return res.status(400).json({error:"Invalid account status."});
 const target=db.prepare("SELECT id,role,parent_id FROM users WHERE id=?").get(id);
 if(!target || target.role==="admin")return res.status(404).json({error:"Account not found."});
 if(req.user.role==="master"&&(target.role!=="player"||target.parent_id!==req.user.id))
  return res.status(403).json({error:"You can only manage your own players."});
 db.transaction(()=>{
  db.prepare("UPDATE users SET active=? WHERE id=?").run(active?1:0,id);
  if(!active)db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
 })();
 res.json({ok:true,active});
});
app.post("/api/accounts/:id/password",auth,roles("admin","master"),(req,res)=>{
 const id=Number(req.params.id),password=req.body?.password;
 if(!Number.isInteger(id)||!passwordOKFormat(password))return res.status(400).json({error:"Password must be at least 10 characters."});
 const target=db.prepare("SELECT id,role,parent_id FROM users WHERE id=?").get(id);
 if(!target||target.role==="admin")return res.status(404).json({error:"Account not found."});
 if(req.user.role==="master"&&(target.role!=="player"||target.parent_id!==req.user.id))
  return res.status(403).json({error:"You can only manage your own players."});
 db.transaction(()=>{
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(passwordHash(password),id);
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
 })();
 res.json({ok:true});
});
app.get("/api/transactions.csv",auth,(req,res)=>{
 let rows;
 const select=`SELECT l.id,l.created_at,l.action,l.amount,l.note,a.username actor,
   f.username from_user,t.username to_user
   FROM ledger l JOIN users a ON a.id=l.actor_id
   LEFT JOIN users f ON f.id=l.from_user_id
   LEFT JOIN users t ON t.id=l.to_user_id`;
 if(req.user.role==="admin"){
  rows=db.prepare(select+" ORDER BY l.id DESC").all();
 }else if(req.user.role==="master"){
  rows=db.prepare(select+` WHERE
   l.from_user_id IN (SELECT id FROM users WHERE parent_id=? AND role='player')
   OR l.to_user_id IN (SELECT id FROM users WHERE parent_id=? AND role='player')
   ORDER BY l.id DESC`).all(req.user.id,req.user.id);
 }else{
  rows=db.prepare(select+" WHERE l.from_user_id=? OR l.to_user_id=? ORDER BY l.id DESC").all(req.user.id,req.user.id);
 }
 const cell=value=>{
  let text=String(value??"");
  if(/^[=+\-@\t\r]/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
 };
 const columns=["id","created_at","action","actor","from_user","to_user","amount","note"];
 const lines=[columns.join(","),...rows.map(row=>columns.map(key=>cell(row[key])).join(","))];
 res.setHeader("Content-Type","text/csv; charset=utf-8");
 res.setHeader("Content-Disposition",`attachment; filename="playzone-transactions-${req.user.role}.csv"`);
 res.send("\uFEFF"+lines.join("\r\n"));
});
app.get("/api/dashboard",auth,(req,res)=>{
 if(req.user.role==="admin"){
  const counts=db.prepare("SELECT COUNT(*) total,SUM(role='master') masters,SUM(role='player') players FROM users").get();
  const reserve=Number(db.prepare("SELECT value FROM settings WHERE key='reserve'").get()?.value||0);
  const masters=db.prepare(`SELECT u.id,u.username,u.display_name,u.active,l.allocated,l.available,
   (SELECT COUNT(*) FROM users p WHERE p.parent_id=u.id AND p.role='player') players
   FROM users u JOIN master_limits l ON l.master_id=u.id WHERE u.role='master' ORDER BY u.id DESC`).all();
  const ledger=db.prepare("SELECT l.*,a.username actor,f.username from_user,t.username recipient FROM ledger l JOIN users a ON a.id=l.actor_id LEFT JOIN users f ON f.id=l.from_user_id LEFT JOIN users t ON t.id=l.to_user_id ORDER BY l.id DESC LIMIT 100").all();
  res.json({role:"admin",counts,reserve:"UNLIMITED",masters,ledger});
 }else if(req.user.role==="master"){
  const allocation=db.prepare("SELECT * FROM master_limits WHERE master_id=?").get(req.user.id);
  const players=db.prepare("SELECT id,username,display_name,balance,active FROM users WHERE parent_id=? AND role='player' ORDER BY id DESC").all(req.user.id);
const history = db.prepare(`
  SELECT
    l.id,
    l.action,
    l.amount,
    l.note,
    l.created_at,
    a.username AS actor,
    f.username AS from_user,
    t.username AS to_user
  FROM ledger l
  LEFT JOIN users a ON a.id = l.actor_id
  LEFT JOIN users f ON f.id = l.from_user_id
  LEFT JOIN users t ON t.id = l.to_user_id
  WHERE
    l.from_user_id IN (
      SELECT id FROM users
      WHERE parent_id = ? AND role = 'player'
    )
    OR
    l.to_user_id IN (
      SELECT id FROM users
      WHERE parent_id = ? AND role = 'player'
    )
  ORDER BY l.id DESC
  LIMIT 100
`).all(req.user.id, req.user.id);

res.json({
  role: "master",
  allocation,
  players,
  history
});
 }else{
  const h=db.prepare("SELECT action,amount,note,created_at FROM ledger WHERE to_user_id=? OR from_user_id=? ORDER BY id DESC LIMIT 25").all(req.user.id,req.user.id);
  res.json({role:"player",balance:req.user.balance,history:h});
 }
});
app.use(express.static(path.join(__dirname,"public")));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(Number(process.env.PORT||3000),"0.0.0.0",()=>console.log("PLAYZONE running on port "+(process.env.PORT||3000)));
