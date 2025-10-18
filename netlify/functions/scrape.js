// netlify/functions/scrape.js
const axios = require("axios");
const cheerio = require("cheerio");
const NodeCache = require("node-cache");

// Simple in-memory cache to reduce repeated fetches on Netlify instances
const cache = new NodeCache({ stdTTL: 60 * 5, checkperiod: 120 }); // cache 5 minutes

// Default target site (you can pass ?url= to override)
const DEFAULT_BASE = "https://simpel.pekalongankab.go.id";

// Use environment variable for User-Agent if provided (safer)
const DEFAULT_UA =
  process.env.SCRAPER_UA ||
  "netlify-scraper/1.0 (+https://github.com/Afihacked; contact: afitech.services@gmail.com)";

exports.handler = async function (event, context) {
  try {
    const qs = event.queryStringParameters || {};
    const url = qs.url ? decodeURIComponent(qs.url) : DEFAULT_BASE;
    const debug = qs.debug === "1" || qs.debug === "true";

    // Basic validation: allow only same-origin or paths under the domain to avoid open proxy abuse
    if (!isAllowedUrl(url)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "URL not allowed. Use a path or the configured domain.",
        }),
      };
    }

    // Check cache (cache key includes debug flag so debug responses are fresh)
    const cacheKey = `scrape:${url}:${debug ? "debug" : "nodebug"}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, cached: true, data: cached }),
      };
    }

    // Fetch HTML
    const res = await axios.get(url, {
      headers: {
        "User-Agent": DEFAULT_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      timeout: 15000,
      responseType: "text",
      maxRedirects: 5,
    });

    const html = res.data || "";
    const html_sample = html.slice(0, 3000); // first bytes for debug

    const $ = cheerio.load(html);

    // Extract useful data: title, meta, headings, links, tables
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
      const tagName =
        el && (el.tagName || el.name)
          ? (el.tagName || el.name).toLowerCase()
          : "h";
      headings.push({ tag: tagName, text: $(el).text().trim() });
    });

    const links = [];
    $("a").each((i, el) => {
      const $el = $(el);
      const href = $el.attr("href") || "";
      const text = $el.text().trim() || null;
      // Normalize relative URLs to absolute when possible
      const absolute = makeAbsoluteUrl(url, href);
      links.push({ href: absolute, text });
    });

    const tables = [];
    $("table").each((i, tableEl) => {
      const $table = $(tableEl);
      const rows = [];
      $table.find("tr").each((ri, tr) => {
        const $tr = $(tr);
        const cols = [];
        $tr.find("th, td").each((ci, td) => {
          cols.push($(td).text().trim());
        });
        rows.push(cols);
      });
      tables.push(rows);
    });

    const data = { url, title, metas, headings, links, tables };

    // store to cache
    cache.set(cacheKey, data);

    // If debug requested, include HTML sample and HTTP status
    if (debug) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ok: true,
          cached: false,
          data: { ...data, status: res.status, html_sample },
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
      body: JSON.stringify({
        ok: false,
        error:
          err && err.message ? err.message : String(err) || "Unknown error",
      }),
    };
  }
};

// Helpers
function isAllowedUrl(target) {
  try {
    const t = new URL(target, DEFAULT_BASE);
    // only allow same host as DEFAULT_BASE, or paths within it
    const base = new URL(DEFAULT_BASE);
    return t.hostname === base.hostname;
  } catch (e) {
    return false;
  }
}

function makeAbsoluteUrl(base, href) {
  try {
    if (!href) return null;
    // if href already absolute
    if (/^https?:\/\//i.test(href)) return href;
    // ignore javascript: and mailto:
    if (/^(javascript:|mailto:|#)/i.test(href)) return href;
    const baseUrl = new URL(base);
    return new URL(href, baseUrl).toString();
  } catch (e) {
    return href;
  }
}
