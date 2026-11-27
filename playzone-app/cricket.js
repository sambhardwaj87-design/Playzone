const express = require("express");

module.exports = function mountCricketRoutes(app, requireUser) {
  const router = express.Router();
  const BASE = "https://cricket.sportmonks.com/api/v2.0";
  let cache = { at: 0, data: null };
  const CACHE_MS = 20000;

  function configured(req, res, next) {
    if (!process.env.SPORTMONKS_CRICKET_TOKEN) {
      return res.status(503).json({
        configured: false,
        provider: "Sportmonks Cricket API",
        message: "Live cricket data is not connected yet. Add SPORTMONKS_CRICKET_TOKEN to the server environment."
      });
    }
    next();
  }

  async function provider(path) {
    const url = new URL(BASE + path);
    url.searchParams.set("api_token", process.env.SPORTMONKS_CRICKET_TOKEN);
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) {
      const error = new Error("Cricket data provider returned HTTP " + response.status);
      error.status = response.status === 429 ? 503 : 502;
      throw error;
    }
    const body = await response.json();
    if (body.message && !body.data) throw new Error("Cricket data provider rejected the request.");
    return body.data || [];
  }

  router.get("/status", (req, res) => res.json({
    configured: !!process.env.SPORTMONKS_CRICKET_TOKEN,
    provider: "Sportmonks Cricket API",
    cacheSeconds: CACHE_MS / 1000
  }));

  router.get("/matches/live", configured, async (req, res, next) => {
    try {
      if (cache.data && Date.now() - cache.at < CACHE_MS) return res.json({ configured: true, cached: true, matches: cache.data });
      const data = await provider("/livescores?include=localteam,visitorteam,league,season,runs,scoreboards");
      cache = { at: Date.now(), data };
      res.json({ configured: true, cached: false, matches: data });
    } catch (error) { next(error); }
  });

  router.get("/matches/:id", configured, async (req, res, next) => {
    if (!/^\\d+$/.test(req.params.id)) return res.status(400).json({ error: "Invalid match ID." });
    try {
      const data = await provider("/fixtures/" + req.params.id + "?include=localteam,visitorteam,league,season,venue,runs,scoreboards,batting,bowling,lineup,balls");
      res.json({ match: data });
    } catch (error) { next(error); }
  });

  app.use("/api/cricket", requireUser, router);
};
