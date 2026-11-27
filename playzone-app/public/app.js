const $=s=>document.querySelector(s), esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function api(url,opt={}){const r=await fetch(url,{...opt,credentials:"same-origin",headers:{"Content-Type":"application/json",...(opt.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||"Request failed");return d}
const values=f=>Object.fromEntries(new FormData(f).entries()), say=t=>$("#message").textContent=t||"";
function stat(k,v){return `<div class="stat"><small>${esc(k)}</small><strong>${esc(v)}</strong></div>`}
function modal(title,fields,handler){$("#modalTitle").textContent=title;$("#modalFields").innerHTML=fields;$("#modal").showModal();$("#modalForm").onsubmit=async e=>{e.preventDefault();try{await handler(values(e.target));$("#modal").close();await refresh()}catch(x){alert(x.message)}}}
$("#close").onclick=()=>$("#modal").close();
async function refresh(){const {user}=await api("/api/me");const d=await api("/api/dashboard");$("#login").hidden=true;$("#intro").hidden=true;$("#dash").hidden=false;$("#greeting").textContent="Welcome, "+user.displayName;$("#role").textContent=user.role.toUpperCase()+" DASHBOARD";let actions=$("#actions"),content=$("#content");actions.innerHTML="";content.innerHTML="";
if(d.role==="admin"){
 $("#stats").innerHTML=stat("Masters",d.counts.masters||0)+stat("Players",d.counts.players||0)+stat("Admin virtual points","UNLIMITED");
 actions.innerHTML='<button id="newMaster">＋ Create Master</button><button id="exportTransactions" class="ghost">Export all transactions</button>';
 content.innerHTML=`<section class="card"><h3>Master accounts</h3>${d.masters.map(m=>`<div class="item"><div class="row"><b>${esc(m.display_name)}</b><span class="badge">${m.active?"ACTIVE":"DISABLED"}</span></div><div class="mini">@${esc(m.username)} · ${m.players} players</div><div class="row"><span>Available ${m.available.toLocaleString()} / ${m.allocated.toLocaleString()}</span><button class="ghost" data-quota="${m.id}">Adjust quota</button><button class="ghost" data-status="${m.id}" data-active="${m.active?1:0}">${m.active?"Disable":"Enable"}</button><button class="ghost" data-password="${m.id}">Reset password</button></div></div>`).join("")||'<p class="muted">No masters created yet.</p>'}</section><section class="card"><h3>Recent ledger</h3>${d.ledger.map(x=>`<div class="item"><b>${esc(x.action)}</b><div class="mini">By ${esc(x.actor)} · ${esc(x.created_at)}</div><div class="mini">${esc(x.from_user||"Reserve")} → ${esc(x.recipient||"Reserve")}</div>${x.amount.toLocaleString()} points</div>`).join("")}</section>`;
 $("#newMaster").onclick=()=>modal("Create Master",'<label>Display name<input name="displayName" required></label><label>Username<input name="username" required minlength="3"></label><label>Temporary password<input name="password" type="password" required minlength="10"></label><label>Point quota<input name="allocation" type="number" min="0" value="10000" required></label>',async x=>api("/api/admin/masters",{method:"POST",body:JSON.stringify({...x,allocation:Number(x.allocation)})}));
 content.querySelectorAll("[data-quota]").forEach(b=>b.onclick=()=>modal("Adjust master quota",'<p class="hint">Positive adds quota; negative recalls only unused quota.</p><label>Adjustment<input name="amount" type="number" required></label>',async x=>api(`/api/admin/masters/${b.dataset.quota}/allocation`,{method:"POST",body:JSON.stringify({amount:Number(x.amount)})})));
 content.querySelectorAll("[data-status]").forEach(b=>b.onclick=async()=>{
  if(!confirm((b.dataset.active==="1"?"Disable":"Enable")+" this master account?"))return;
  try{await api(`/api/accounts/${b.dataset.status}/status`,{method:"POST",body:JSON.stringify({active:b.dataset.active!=="1"})});await refresh()}catch(e){alert(e.message)}
 });
 content.querySelectorAll("[data-password]").forEach(b=>b.onclick=()=>modal("Reset master password",'<label>New password (10+ characters)<input name="password" type="password" minlength="10" required></label>',async x=>api(`/api/accounts/${b.dataset.password}/password`,{method:"POST",body:JSON.stringify({password:x.password})})));

}else if(d.role==="master"){
 $("#stats").innerHTML=stat("Allocated quota",d.allocation.allocated.toLocaleString())+stat("Available",d.allocation.available.toLocaleString())+stat("Players",d.players.length);
 actions.innerHTML='<button id="newPlayer">＋ Create Player</button><button id="exportTransactions" class="ghost">Export player transactions</button>';
 content.innerHTML=`<section class="card"><h3>Your players</h3>${d.players.map(p=>`<div class="item"><div class="row"><b>${esc(p.display_name)}</b><span class="badge">${p.active?"ACTIVE":"DISABLED"}</span></div><div class="mini">@${esc(p.username)}</div><div class="row"><b>${p.balance.toLocaleString()} points</b><button class="ghost" data-points="${p.id}">Adjust</button><button class="ghost" data-status="${p.id}" data-active="${p.active?1:0}">${p.active?"Disable":"Enable"}</button><button class="ghost" data-password="${p.id}">Reset password</button></div></div>`).join("")||'<p class="muted">No players yet.</p>'}</section>`;

 $("#newPlayer").onclick=()=>modal("Create Player",'<label>Display name<input name="displayName" required></label><label>Username<input name="username" required minlength="3"></label><label>Temporary password<input name="password" type="password" required minlength="10"></label><label>Starting points<input name="startingBalance" type="number" min="0" value="0"></label>',async x=>api("/api/players",{method:"POST",body:JSON.stringify({...x,startingBalance:Number(x.startingBalance||0)})}));
 content.querySelectorAll("[data-points]").forEach(b=>b.onclick=()=>modal("Adjust player points",'<p class="hint">Positive credits from your quota. Negative debits points back to your quota.</p><label>Adjustment<input name="amount" type="number" required></label><label>Reason<input name="note" maxlength="160"></label>',async x=>api(`/api/players/${b.dataset.points}/points`,{method:"POST",body:JSON.stringify({amount:Number(x.amount),note:x.note||""})})));
 content.querySelectorAll("[data-status]").forEach(b=>b.onclick=async()=>{
  if(!confirm((b.dataset.active==="1"?"Disable":"Enable")+" this player account?"))return;
  try{await api(`/api/accounts/${b.dataset.status}/status`,{method:"POST",body:JSON.stringify({active:b.dataset.active!=="1"})});await refresh()}catch(e){alert(e.message)}
 });
 content.querySelectorAll("[data-password]").forEach(b=>b.onclick=()=>modal("Reset player password",'<label>New password (10+ characters)<input name="password" type="password" minlength="10" required></label>',async x=>api(`/api/accounts/${b.dataset.password}/password`,{method:"POST",body:JSON.stringify({password:x.password})})));


content.insertAdjacentHTML("beforeend",
'<section class="card"><h3>Recent Transactions</h3>' +
((d.history || []).map(x =>
'<div class="item"><div class="row"><b>' +
esc(x.action || "POINT_ADJUSTMENT") +
'</b><span>' + Number(x.amount).toLocaleString() +
' points</span></div><div class="mini">' +
esc(x.from_user || "") + ' → ' +
esc(x.to_user || "") + ' · ' +
esc(x.note || "") + ' · ' +
esc(x.created_at || "") +
'</div></div>'
).join("") || '<p class="muted">No transactions yet.</p>') +
'</section>');

}else{
 actions.innerHTML='<button id="exportTransactions" class="ghost">Export my transactions</button>';
 $("#stats").innerHTML=stat("Your virtual points",d.balance.toLocaleString())+stat("Recent transactions",d.history.length);
 content.innerHTML=`<section class="card"><h3>🎯 Number challenge</h3><p class="muted">A casual demo game. It does not change your balance or award prizes.</p><label>Pick a number from 1 to 5<input id="guess" type="number" min="1" max="5"></label><button id="play">Play round</button><p id="result"></p></section><section class="card"><h3>Point history</h3>${d.history.map(x=>`<div class="item"><b>${esc(x.action)}</b><div class="mini">${esc(x.note)} · ${esc(x.created_at)}</div>${x.amount} points</div>`).join("")}</section>`;
 $("#play").onclick=()=>{$("#result").textContent=Number($("#guess").value)>=1&&Number($("#guess").value)<=5?"Nice! Demo round complete. No points were changed.":"Choose a number from 1 to 5.";};
}
 const exportButton=$("#exportTransactions");
 if(exportButton)exportButton.onclick=()=>{window.location.href="/api/transactions.csv"};
}
$("#loginForm").onsubmit=async e=>{e.preventDefault();say("Signing in…");try{await api("/api/login",{method:"POST",body:JSON.stringify(values(e.target))});e.target.reset();await refresh()}catch(x){say(x.message)}};
$("#setupForm").onsubmit=async e=>{e.preventDefault();say("Creating Main Admin…");try{await api("/api/setup",{method:"POST",body:JSON.stringify(values(e.target))});e.target.reset();await refresh()}catch(x){say(x.message)}};
$("#logout").onclick=async()=>{await api("/api/logout",{method:"POST"});$("#dash").hidden=true;$("#login").hidden=false;$("#intro").hidden=false;say("Signed out.")};
(async()=>{
 const isSetupPage=window.location.pathname.replace(/\/$/,"")==="/setup";
 try{
  const s=await api("/api/setup-status");
  if(isSetupPage && s.needsAdmin){
   $("#loginForm").hidden=true;
   $("#setupForm").hidden=false;
   $("#intro").hidden=true;
   $("#liveHub").hidden=true;
  }else{
   $("#setupForm").hidden=true;
   $("#loginForm").hidden=false;
   if(isSetupPage && !s.needsAdmin){
    $("#login").hidden=false;
    say("Main Admin is already configured. Please sign in from the home page.");
   }
  }
  try{await refresh()}catch{}
 }catch(e){say(e.message)}
})();


// Installable Progressive Web App support.
let installPrompt=null;
window.addEventListener("beforeinstallprompt",event=>{
 event.preventDefault();
 installPrompt=event;
 const button=$("#installApp");
 if(button){button.hidden=false;button.onclick=async()=>{
  if(!installPrompt)return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt=null;
  button.hidden=true;
 };}
});
if("serviceWorker" in navigator){
 window.addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(()=>{}));
}


// PLAYZONE Cricket Centre — live fixtures and match detail, with no wagering features.
function cricketTeam(match, side) {
  const key = side === "home" ? "localteam" : "visitorteam";
  const team = match?.[key]?.data || match?.[key] || {};
  return team.name || team.code || (side === "home" ? "Home team" : "Away team");
}
function cricketScore(match) {
  const runs = match?.runs?.data || match?.runs || [];
  if (Array.isArray(runs) && runs.length) {
    return runs.map(x => {
      const score = x.score ?? x.total ?? "";
      const wickets = x.wickets ?? "";
      const overs = x.overs ?? "";
      return [score !== "" ? score + (wickets !== "" ? "/" + wickets : "") : "", overs !== "" ? "(" + overs + " ov)" : ""].filter(Boolean).join(" ");
    }).filter(Boolean).join(" · ");
  }
  const boards = match?.scoreboards?.data || match?.scoreboards || [];
  if (Array.isArray(boards) && boards.length) return boards.map(x => [x.total ?? x.score, x.wickets != null ? "/" + x.wickets : "", x.overs != null ? "(" + x.overs + " ov)" : ""].join("")).join(" · ");
  return "Score not available yet";
}
function cricketDate(match) {
  const raw = match.starting_at || match.start_at || match.date || "";
  if (!raw) return match.status || "Scheduled";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? String(raw) : d.toLocaleString();
}
async function loadCricketCentre() {
  const hub = $("#liveHub");
  if (!hub) return;
  hub.innerHTML = '<small>PLAYZONE LIVE CENTRE · CRICKET</small><div class="row cricket-heading"><div><h2>Live & upcoming matches</h2><p class="muted">International and domestic cricket, together in one place.</p></div><button id="cricketRefresh" class="ghost">Refresh</button></div><div id="cricketStatus" class="mini">Checking cricket data connection…</div><div id="cricketMatches" class="cricket-list"></div><div id="cricketDetail" class="cricket-detail"></div>';
  const status = $("#cricketStatus"), list = $("#cricketMatches");
  try {
    const state = await api("/api/cricket/status");
    if (!state.configured) { status.textContent = state.message || "Cricket provider token is not configured."; return; }
    status.textContent = "Data provider connected · Sportmonks Cricket";
    const data = await api("/api/cricket/matches/live");
    const matches = Array.isArray(data.matches) ? data.matches : [];
    if (!matches.length) { list.innerHTML = '<div class="item"><b>No live matches returned right now.</b><p class="mini">Check again later or browse upcoming fixtures when that endpoint is added.</p></div>'; return; }
    list.innerHTML = matches.map(m => '<button class="cricket-match" data-cricket-id="' + encodeURIComponent(m.id) + '"><span class="cricket-league">' + esc(m.league?.data?.name || m.league?.name || m.season?.data?.name || "Cricket") + '</span><span class="cricket-teams">' + esc(cricketTeam(m,"home")) + ' <small>vs</small> ' + esc(cricketTeam(m,"away")) + '</span><strong>' + esc(cricketScore(m)) + '</strong><span class="mini">' + esc(m.status || cricketDate(m)) + '</span></button>').join("");
    list.querySelectorAll("[data-cricket-id]").forEach(button => button.addEventListener("click", () => showCricketMatch(decodeURIComponent(button.dataset.cricketId))));
  } catch (error) {
    status.textContent = error.message.includes("sign in") ? "Sign in to view your private group’s live cricket centre." : "Cricket data unavailable: " + error.message;
  }
  const refresh = $("#cricketRefresh");
  if (refresh) refresh.onclick = loadCricketCentre;
}
async function showCricketMatch(id) {
  const target = $("#cricketDetail");
  if (!target) return;
  target.innerHTML = '<p class="mini">Loading match details…</p>';
  try {
    const result = await api("/api/cricket/matches/" + encodeURIComponent(id));
    const match = result.match || {};
    const blocks = ["scoreboards","runs","batting","bowling","balls","lineup"].map(key => {
      const value = match[key]?.data || match[key];
      if (!value || (Array.isArray(value) && !value.length)) return "";
      const rows = Array.isArray(value) ? value : [value];
      return '<section class="score-block"><h4>' + esc(key.charAt(0).toUpperCase()+key.slice(1)) + '</h4>' + rows.slice(0,30).map(row => '<div class="mini score-row">' + esc([row.name,row.player?.data?.fullname || row.player?.fullname,row.score,row.total,row.wickets,row.overs,row.ball,row.runs,row.commentary].filter(x=>x!==undefined&&x!==null&&x!=="").join(" · ") || JSON.stringify(row)) + '</div>').join("") + '</section>';
    }).join("");
    target.innerHTML = '<section class="card"><div class="row"><h3>' + esc(cricketTeam(match,"home")) + ' vs ' + esc(cricketTeam(match,"away")) + '</h3><button id="closeCricketDetail" class="ghost">Close</button></div><p class="muted">' + esc(match.league?.data?.name || match.league?.name || "Cricket") + ' · ' + esc(match.status || cricketDate(match)) + '</p><h3>' + esc(cricketScore(match)) + '</h3>' + (blocks || '<p class="mini">Detailed scorecard has not been supplied for this match.</p>') + '</section>';
    $("#closeCricketDetail").onclick = () => { target.innerHTML = ""; };
  } catch (error) { target.innerHTML = '<p class="mini">Could not load match details: ' + esc(error.message) + '</p>'; }
}
let cricketRefreshTimer = null;
const originalRefreshForCricket = refresh;
refresh = async function() {
  await originalRefreshForCricket();
  await loadCricketCentre();
  if (cricketRefreshTimer) clearInterval(cricketRefreshTimer);
  cricketRefreshTimer = setInterval(() => { if (!document.hidden && !$("#dash").hidden) loadCricketCentre(); }, 30000);
};
