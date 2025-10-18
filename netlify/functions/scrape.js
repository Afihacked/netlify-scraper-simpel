// netlify/functions/scrape.js
const axios = require("axios");
const cheerio = require("cheerio");
const NodeCache = require("node-cache");

// Simple in-memory cache
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
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "URL not allowed." }),
      };
    }

    const cacheKey = `scrape:${url}:${debug ? "debug" : "nodebug"}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, cached: true, data: cached }),
      };
    }

    const res = await axios.get(url, {
      headers: { "User-Agent": DEFAULT_UA, Accept: "text/html" },
      timeout: 15000,
    });

    const html = res.data || "";
    const $ = cheerio.load(html);

    // 1) Try to detect data-page on #app (Inertia-style)
    let dataPage = null;
    const appEl = $("#app");
    if (appEl && appEl.attr("data-page")) {
      const raw = appEl.attr("data-page");
      // decode common HTML entities produced by attribute encoding
      const decoded = decodeHtmlEntities(raw);
      try {
        dataPage = JSON.parse(decoded);
      } catch (e) {
        // fallback: try to unescape quotes then parse
        try {
          dataPage = JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
        } catch (ee) {
          dataPage = null;
        }
      }
    }

    // 2) Extract standard HTML items (headings/links/tables) for fallback
    const title = ($("head > title").text() || "").trim();
    const metas = {};
    $("head meta").each((i, el) => {
      const $el = $(el);
      const name =
        $el.attr("name") || $el.attr("property") || $el.attr("itemprop");
      const content = $el.attr("content");
      if (name && content) metas[name] = content;
    });

    const headings = [];
    $("h1,h2,h3,h4,h5").each((i, el) => {
      const tagName = el && (el.tagName || el.name) ? (el.tagName || el.name).toLowerCase() : "h";
      headings.push({ tag: tagName, text: $(el).text().trim() });
    });

    const links = [];
    $("a").each((i, el) => {
      const $el = $(el);
      const href = $el.attr("href") || "";
      const text = $el.text().trim() || null;
      links.push({ href: makeAbsoluteUrl(url, href), text });
    });

    // 3) If dataPage exists, extract useful parts
    let parsed = null;
    if (dataPage && typeof dataPage === "object") {
      const props = dataPage.props || {};
      parsed = {
        component: dataPage.component || null,
        propsSummary: summarizeProps(props),
        settings: props.settings || null,
        years: props.years || null,
        budgets: props.budgets || null,
        ziggy: (props.ziggy ? props.ziggy : dataPage.props && dataPage.props.ziggy) || null,
      };

      // If ziggy found, extract routes (map to full URLs)
      if (parsed.ziggy && parsed.ziggy.url && parsed.ziggy.routes) {
        parsed.routes = mapZiggyRoutesToUrls(parsed.ziggy.url, parsed.ziggy.routes);
      }
    }

    const data = { url, title, metas, headings, links, parsed };

    cache.set(cacheKey, data);

    // If debug requested include html sample and status
    if (debug) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ok: true,
          cached: false,
          data: { ...data, status: res.status, html_sample: html.slice(0, 3000) },
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, cached: false, data }),
    };
  } catch (err) {
    console.error("Scrape error", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }),
    };
  }
};

// ---------- helpers ----------
function isAllowedUrl(target) {
  try {
    const t = new URL(target, DEFAULT_BASE);
    const base = new URL(DEFAULT_BASE);
    return t.hostname === base.hostname;
  } catch (e) {
    return false;
  }
}

function makeAbsoluteUrl(base, href) {
  try {
    if (!href) return null;
    if (/^https?:\/\//i.test(href)) return href;
    if (/^(javascript:|mailto:|#)/i.test(href)) return href;
    const baseUrl = new URL(base);
    return new URL(href, baseUrl).toString();
  } catch (e) {
    return href;
  }
}

function decodeHtmlEntities(str) {
  if (!str || typeof str !== "string") return str;
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'");
}

function summarizeProps(props) {
  // Return lightweight summary of props keys to avoid huge payloads
  const summary = {};
  if (!props) return summary;
  const candidateKeys = ["settings", "years", "budgets", "perPages", "app", "auth", "ziggy"];
  candidateKeys.forEach((k) => {
    if (props[k]) summary[k] = props[k];
  });
  // include any top-level arrays like years/budgets
  return summary;
}

function mapZiggyRoutesToUrls(baseUrl, routes) {
  try {
    const out = {};
    const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    Object.keys(routes).forEach((k) => {
      const r = routes[k];
      if (r && r.uri) {
        // join base + '/' + r.uri (ensure no double slash)
        const uri = r.uri.startsWith("/") ? r.uri : "/" + r.uri;
        out[k] = base + uri;
      }
    });
    return out;
  } catch (e) {
    return null;
  }
}
