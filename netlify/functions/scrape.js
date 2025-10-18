// netlify/functions/scrape.js
const axios = require("axios");
const cheerio = require("cheerio");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 60 * 5, checkperiod: 120 });
const DEFAULT_BASE = "https://simpel.pekalongankab.go.id";
const DEFAULT_UA =
  process.env.SCRAPER_UA ||
  "netlify-scraper/1.0 (+https://github.com/Afihacked; contact: afitech.services@gmail.com)";

exports.handler = async function (event) {
  try {
    const qs = event.queryStringParameters || {};
    const url = qs.url ? decodeURIComponent(qs.url) : DEFAULT_BASE;
    const debug = qs.debug === "1" || qs.debug === "true";

    if (!isAllowedUrl(url)) {
      return { statusCode: 400, body: JSON.stringify({ error: "URL not allowed." }) };
    }

    const cacheKey = `scrape:${url}:${debug ? "debug" : "nodebug"}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, cached: true, data: cached }) };
    }

    const res = await axios.get(url, {
      headers: { "User-Agent": DEFAULT_UA, Accept: "text/html,application/xhtml+xml" },
      timeout: 15000,
      maxRedirects: 5,
    });

    const html = res.data || "";
    const $ = cheerio.load(html);

    // decode data-page if present (Inertia-like)
    let dataPage = null;
    const appEl = $("#app");
    if (appEl && appEl.attr("data-page")) {
      const raw = appEl.attr("data-page");
      const decoded = decodeHtmlEntities(raw);
      try {
        dataPage = JSON.parse(decoded);
      } catch (e) {
        try {
          dataPage = JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
        } catch (ee) {
          dataPage = null;
        }
      }
    }

    // basic HTML extraction
    const title = ($("head > title").text() || "").trim();
    const metas = {};
    $("head meta").each((i, el) => {
      const $el = $(el);
      const name = $el.attr("name") || $el.attr("property") || $el.attr("itemprop");
      const content = $el.attr("content");
      if (name && content) metas[name] = content;
    });

    // build parsed result
    const parsed = {};
    if (dataPage) {
      parsed.component = dataPage.component || null;
      parsed.props = dataPage.props || null;
      // ziggy routes: map to full URLs
      const zig = (dataPage.props && dataPage.props.ziggy) || dataPage.ziggy || null;
      if (zig && zig.url && zig.routes) {
        parsed.routes = mapZiggyRoutesToUrls(zig.url, zig.routes);
      }
    }

    // Try to call common API endpoints (if available)
    const apiResults = {};
    if (parsed.routes) {
      // set of routes to try (order: report, paket.list, kegiatan, program)
      const routeKeys = ["report.index", "report", "paket.list", "paket.index", "kegiatan.index", "program.index"];
      // fallback names that appear in earlier ziggy map (some names might be 'report' or 'report.index')
      const tried = new Set();
      for (const key of routeKeys) {
        // find actual URL in parsed.routes by either exact key or fallback direct key names
        const candidates = Object.keys(parsed.routes).filter(k => k === key || k.endsWith(key) || k === key.replace('.index',''));
        for (const cand of candidates) {
          if (tried.has(cand)) continue;
          const routeUrl = parsed.routes[cand];
          if (!routeUrl) continue;
          // call it with Accept: application/json
          try {
            // Add sensible query params: page/perPage/year if available
            const qp = {};
            if (parsed.props && parsed.props.settings && parsed.props.settings.budget_year) qp.year = parsed.props.settings.budget_year;
            qp.page = 1;
            qp.perPage = 50;
            const urlWithQs = addQueryParams(routeUrl, qp);
            const r = await fetchJson(urlWithQs);
            apiResults[cand] = { ok: true, url: urlWithQs, data: r };
          } catch (e) {
            apiResults[cand] = { ok: false, error: e.message || String(e) };
          }
          tried.add(cand);
        }
      }
    }

    const data = { url, title, metas, parsed, api: apiResults };

    cache.set(cacheKey, data);

    if (debug) {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, cached: false, data: { ...data, status: res.status, html_sample: html.slice(0, 3000) } }) };
    }

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, cached: false, data }) };
  } catch (err) {
    console.error("Scrape error", err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }) };
  }
};

// ---------- helpers ----------
function fetchJson(url) {
  return axios.get(url, { headers: { Accept: "application/json", "User-Agent": DEFAULT_UA }, timeout: 20000 }).then(r => r.data).catch(e => { throw e; });
}

function addQueryParams(url, params) {
  try {
    const u = new URL(url);
    Object.keys(params).forEach(k => {
      if (params[k] !== undefined && params[k] !== null) u.searchParams.set(k, params[k]);
    });
    return u.toString();
  } catch (e) {
    // fallback: append naive
    const qs = Object.keys(params).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join("&");
    return url + (url.includes("?") ? "&" : "?") + qs;
  }
}

function isAllowedUrl(target) {
  try {
    const t = new URL(target, DEFAULT_BASE);
    const base = new URL(DEFAULT_BASE);
    return t.hostname === base.hostname;
  } catch (e) {
    return false;
  }
}

function mapZiggyRoutesToUrls(baseUrl, routes) {
  try {
    const out = {};
    const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    Object.keys(routes).forEach(k => {
      const r = routes[k];
      if (r && r.uri) {
        const uri = r.uri.startsWith("/") ? r.uri : "/" + r.uri;
        out[k] = base + uri;
      }
    });
    return out;
  } catch (e) {
    return null;
  }
}

function decodeHtmlEntities(str) {
  if (!str || typeof str !== "string") return str;
  return str.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
}
