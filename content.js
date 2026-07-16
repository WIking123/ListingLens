// ============================================================
// ListingLens 2.0 — content.js
// New features: Offer Generator, Negotiation Tips,
//               Comparable Sales, Client Report PDF
// Support: listinglens.outreach@gmail.com
// ============================================================

// Guard against double injection by background.js
if (window.__listingLensLoaded) {
  // Already running — background.js re-injects on every matching URL update,
  // including the same navigation the manifest's own content_scripts entry
  // already handled. Only tear down and rebuild if the URL actually changed;
  // otherwise this is a redundant re-run and would just flicker the sidebar.
  if (typeof window.__listingLensInit === 'function' && window.__listingLensLastUrl !== window.location.href) {
    window.__listingLensInit();
  }
} else {
window.__listingLensLoaded = true;
window.__listingLensLastUrl = window.location.href;

(function () {
  "use strict";

  const SIDEBAR_ID = "listinglens-sidebar";
  const FREE_LIMIT = 5;
  const WORKER_URL = "https://listinglens-api.bison-animol.workers.dev";
  const SUPPORT_EMAIL = "listinglens.outreach@gmail.com";
  const STRIPE_URL = "https://buy.stripe.com/fZu28q3Tf2Xh84M2b13gk01";

  // Escape untrusted text (AI response fields, scraped listing data) before
  // it's interpolated into innerHTML — both sources are third-party content.
  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // A price_score of 0 is a valid (if extreme) AI answer — `|| 5` would
  // silently treat it as missing, so check for a real number instead.
  function safeScore(score) {
    return Number.isFinite(score) ? score : 5;
  }

  // ─── 1. Scrape listing data ──────────────────────────────────────────────

  function scrapeListing() {
    const get = (selectors) => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el?.innerText?.trim()) return el.innerText.trim();
      }
      return "";
    };
    const getAll = (selectors) => {
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length) return Array.from(els).map((e) => e.innerText.trim()).join(", ");
      }
      return "";
    };
    const fullPageText = document.body.innerText || "";

    const price = get(['[data-testid="price"]', 'span[data-testid="price"]', '.summary-container span[class*="price"]', 'span[class*="Price"]'])
      || (fullPageText.match(/\$[\d,]+(?:\.\d+)?(?:\/mo)?/)?.[0] || "");
    const address = get(["h1", '[data-testid="bdp-building-name"]', '[class*="street-address"]']);
    const bedsRaw = getAll(['[data-testid="bed-bath-beyond"] span', '[class*="summary-container"] [class*="beds"]', 'button[data-testid="bed-bath-item"]']);
    const beds = bedsRaw || (fullPageText.match(/(\d+)\s*(?:bd|bed|beds)/i)?.[0] || "") + " " + (fullPageText.match(/(\d+)\s*(?:ba|bath|baths)/i)?.[0] || "");
    const sqft = get(['[data-testid="floor-area"]', '[class*="sqft"]', '[class*="floorArea"]'])
      || (fullPageText.match(/([\d,]+)\s*(?:sqft|sq\s*ft)/i)?.[0] || "");
    const description = get(['[data-testid="listing-description"]', '[class*="listing-description"]', "article", "section p"]).slice(0, 1000)
      || fullPageText.slice(0, 500);
    const facts = getAll(['[data-testid="fact-and-feature"] li', '[class*="fact"] li', '[class*="feature"] li', "dl dt, dl dd"]).slice(0, 600);
    const zestimate = get(['[data-testid="zestimate-text"]', '[class*="zestimate"]', '[class*="Zestimate"]'])
      || (fullPageText.match(/Zestimate[^\$]*(\$[\d,]+)/i)?.[1] || "");
    const daysOnMarket = get(['[data-testid="days-on-zillow"]', '[class*="days-on"]'])
      || (fullPageText.match(/(\d+)\s*days?\s*on\s*(?:Zillow|market)/i)?.[0] || "");
    const yearBuilt = get(['[data-testid="year-built"]', '[class*="yearBuilt"]'])
      || (fullPageText.match(/(?:built|year built)[:\s]*(\d{4})/i)?.[1] || "");
    const propertyType = get(['[data-testid="property-type"]', '[class*="propertyType"]'])
      || (fullPageText.match(/(?:Single.Family|Condo|Townhouse|Multi.Family|Land|Ranch)/i)?.[0] || "");
    const priceHistory = getAll(['[data-testid="price-history"] td', '[class*="priceHistory"] td']).slice(0, 300);
    const neighborhood = get(['[data-testid="neighborhood"]', '[class*="neighborhood"]'])
      || (fullPageText.match(/(?:neighborhood|area)[:\s]*([A-Za-z\s]+)/i)?.[1]?.slice(0, 50) || "");

    return { url: window.location.href, price, address, beds, sqft, description, facts, zestimate, daysOnMarket, yearBuilt, propertyType, priceHistory, neighborhood };
  }

  // ─── 2. Build AI prompt ──────────────────────────────────────────────────

  function buildPrompt(l) {
    return `You are a senior US real estate analyst helping a professional realtor evaluate a property.

LISTING DATA:
- Address: ${l.address || "Not available"}
- Asking price: ${l.price || "Not available"}
- Beds/Baths: ${l.beds || "Not available"}
- Square footage: ${l.sqft || "Not available"}
- Year built: ${l.yearBuilt || "Not available"}
- Property type: ${l.propertyType || "Not available"}
- Zestimate: ${l.zestimate || "Not available"}
- Days on market: ${l.daysOnMarket || "Not available"}
- Price history: ${l.priceHistory || "Not available"}
- Neighborhood: ${l.neighborhood || "Not available"}
- Listing description: ${l.description || "Not available"}
- Key features/facts: ${l.facts || "Not available"}

Respond ONLY with valid JSON — no markdown, no explanation, just raw JSON:

{
  "verdict": "Good deal" | "Fairly priced" | "Possibly overpriced" | "Needs investigation",
  "verdict_reason": "2-3 sentence explanation",
  "price_score": <integer 1-10>,
  "red_flags": ["specific concern", "another if present", "third if applicable"],
  "green_flags": ["positive aspect", "another if present"],
  "questions_to_ask": ["question for seller/agent", "another", "third"],
  "market_context": "1 sentence on current market conditions",
  "negotiation_tips": ["specific negotiation tip based on data", "another tip", "third tip"],
  "comparable_note": "1-2 sentences about what comparable sales likely look like in this area based on the data provided",
  "offer_draft": "Professional offer summary: suggested offer price (as % of asking based on your analysis), suggested contingencies (inspection, financing, appraisal), suggested closing timeline, and 1-2 key negotiation points. Keep it practical and actionable for the realtor.",
  "client_email": "Professional 2-3 sentence email from realtor to buyer client: mention address, key highlights, recommend showing if warranted. Warm, professional tone."
}`;
  }

  // ─── 3. Call OpenRouter API ──────────────────────────────────────────────

  async function analyzeListing(listing) {
    // Stable per-install ID for free-limit tracking on the server
    let { llInstallId } = await chrome.storage.local.get("llInstallId");
    if (!llInstallId) {
      llInstallId = "inst_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      await chrome.storage.local.set({ llInstallId });
    }
    const { llEmail = "" } = await chrome.storage.local.get("llEmail");

    let response;
    try {
      response = await fetch(`${WORKER_URL}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: buildPrompt(listing),
          installId: llInstallId,
          email: llEmail,
        }),
      });
    } catch {
      throw new Error("Network error — check your connection and try again.");
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const code = err?.error || "";
      if (code === "free_limit_reached") throw new Error("__PAYWALL__");
      if (code === "rate_limit") throw new Error("Rate limit hit. Wait a moment and try again.");
      throw new Error(code || `Error (${response.status})`);
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("Invalid response from server. Try again.");
    }
    const raw = data?.content || "";
    if (!raw) throw new Error("Empty response. Try again.");
    return parseAnalysis(raw);
  }

  // ─── 4. Parse response ───────────────────────────────────────────────────

  function parseAnalysis(text) {
    try {
      return JSON.parse(text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim());
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch {} }
      return { error: "Could not parse the analysis. This listing may have too little data — try another one." };
    }
  }

  // ─── 5. Generate PDF report ──────────────────────────────────────────────

  function generatePDF(data, listing) {
    const now = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const score = safeScore(data.price_score);
    const scoreColor = score >= 7 ? "#16a34a" : score >= 5 ? "#2563eb" : "#dc2626";
    const verdictColor = {
      "Good deal": "#16a34a",
      "Fairly priced": "#2563eb",
      "Possibly overpriced": "#d97706",
      "Needs investigation": "#dc2626"
    }[data.verdict] || "#6b7280";

    const flags = (items, icon) => items?.length
      ? items.map(i => `<li style="margin:4px 0;padding:6px 10px;background:#f8fafc;border-radius:6px;font-size:13px;">${icon} ${escapeHtml(i)}</li>`).join("")
      : "<li style='color:#94a3b8;font-size:13px;padding:4px 0'>None identified</li>";

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>ListingLens Report — ${escapeHtml(listing.address || "Property")}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 780px; margin: 0 auto; padding: 40px 30px; color: #1e293b; background: #fff; }
  .header { background: linear-gradient(135deg, #1d4ed8, #1e40af); color: white; padding: 28px 30px; border-radius: 12px; margin-bottom: 28px; }
  .header h1 { font-size: 22px; font-weight: 800; margin: 0 0 4px; }
  .header p { font-size: 13px; opacity: 0.8; margin: 0; }
  .meta { display: flex; gap: 20px; margin-top: 12px; flex-wrap: wrap; }
  .meta-item { font-size: 12px; background: rgba(255,255,255,0.15); padding: 4px 10px; border-radius: 20px; }
  .verdict-box { border-left: 5px solid ${verdictColor}; background: #f8fafc; padding: 16px 20px; border-radius: 8px; margin-bottom: 24px; }
  .verdict-label { font-size: 18px; font-weight: 700; color: ${verdictColor}; margin-bottom: 6px; }
  .verdict-reason { font-size: 14px; color: #475569; line-height: 1.6; margin-bottom: 12px; }
  .score-row { display: flex; align-items: center; gap: 12px; }
  .score-num { font-size: 28px; font-weight: 800; color: ${scoreColor}; }
  .score-bar-bg { flex: 1; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; }
  .score-bar-fill { height: 100%; width: ${score * 10}%; background: ${scoreColor}; border-radius: 4px; }
  .score-label { font-size: 12px; color: #94a3b8; }
  h2 { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #94a3b8; margin: 24px 0 10px; }
  ul { list-style: none; padding: 0; margin: 0; }
  .market-note { background: #f8fafc; border-radius: 8px; padding: 12px 16px; font-size: 14px; color: #475569; line-height: 1.6; }
  .offer-box { background: linear-gradient(135deg, #eff6ff, #dbeafe); border: 1px solid #93c5fd; border-radius: 10px; padding: 16px 20px; font-size: 14px; color: #1e40af; line-height: 1.7; white-space: pre-wrap; }
  .email-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px 20px; font-size: 14px; color: #334155; line-height: 1.7; white-space: pre-wrap; }
  .neg-tip { background: #f0fdf4; border-radius: 6px; padding: 8px 12px; font-size: 13px; color: #166534; margin: 5px 0; }
  .comp-note { background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 8px; padding: 12px 16px; font-size: 14px; color: #6b21a8; line-height: 1.6; }
  .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; }
  .footer-brand { font-size: 13px; font-weight: 700; color: #1d4ed8; }
  .footer-meta { font-size: 11px; color: #94a3b8; }
  @media print { body { padding: 20px; } }
</style>
</head>
<body>
  <div class="header">
    <h1>🏠 ListingLens Report</h1>
    <p>${escapeHtml(listing.address || listing.url)}</p>
    <div class="meta">
      ${listing.price ? `<span class="meta-item">💰 ${escapeHtml(listing.price)}</span>` : ""}
      ${listing.beds ? `<span class="meta-item">🛏 ${escapeHtml(listing.beds)}</span>` : ""}
      ${listing.sqft ? `<span class="meta-item">📐 ${escapeHtml(listing.sqft)}</span>` : ""}
      ${listing.yearBuilt ? `<span class="meta-item">🏗 Built ${escapeHtml(listing.yearBuilt)}</span>` : ""}
      ${listing.daysOnMarket ? `<span class="meta-item">📅 ${escapeHtml(listing.daysOnMarket)}</span>` : ""}
    </div>
  </div>

  <div class="verdict-box">
    <div class="verdict-label">${escapeHtml(data.verdict || "Analysis Complete")}</div>
    <div class="verdict-reason">${escapeHtml(data.verdict_reason || "")}</div>
    <div class="score-row">
      <div class="score-num">${score}/10</div>
      <div style="flex:1">
        <div class="score-bar-bg"><div class="score-bar-fill"></div></div>
        <div class="score-label">Value score</div>
      </div>
    </div>
  </div>

  ${data.market_context ? `<h2>Market Context</h2><div class="market-note">${escapeHtml(data.market_context)}</div>` : ""}

  <h2>🚩 Red Flags</h2>
  <ul>${flags(data.red_flags, "🚩")}</ul>

  <h2>✅ Positives</h2>
  <ul>${flags(data.green_flags, "✅")}</ul>

  <h2>🤝 Negotiation Tips (Pro)</h2>
  ${data.negotiation_tips?.length
    ? data.negotiation_tips.map(t => `<div class="neg-tip">💡 ${escapeHtml(t)}</div>`).join("")
    : "<div class='neg-tip' style='color:#94a3b8'>Not enough data for tips</div>"}

  <h2>📊 Comparable Sales Note (Pro)</h2>
  <div class="comp-note">${escapeHtml(data.comparable_note || "Comparable data not available for this listing.")}</div>

  <h2>📋 Offer Draft (Pro)</h2>
  <div class="offer-box">${escapeHtml(data.offer_draft || "Not enough data to generate offer.")}</div>

  <h2>❓ Questions to Ask</h2>
  <ul>${flags(data.questions_to_ask, "❓")}</ul>

  <h2>✉️ Draft Client Email</h2>
  <div class="email-box">${escapeHtml(data.client_email || "")}</div>

  <div class="footer">
    <div class="footer-brand">🏠 ListingLens 2.0</div>
    <div class="footer-meta">Generated ${now} · ${SUPPORT_EMAIL}</div>
  </div>
</body>
</html>`;

    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ListingLens-Report-${(listing.address || "property").replace(/[^a-z0-9]/gi, "-").slice(0, 40)}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── 6. Render results ───────────────────────────────────────────────────

  function renderResults(data, listing, isPro) {
    const el = document.getElementById("ll-results");
    if (!el) return;

    if (data.error) {
      el.innerHTML = `
        <div class="ll-error">${escapeHtml(data.error)}</div>
        <p class="ll-support-note">Need help? <a href="mailto:${SUPPORT_EMAIL}" class="ll-link">${SUPPORT_EMAIL}</a></p>
        <button class="ll-btn-secondary" id="ll-reset-btn">← Try again</button>`;
      document.getElementById("ll-reset-btn")?.addEventListener("click", resetToIdle);
      return;
    }

    const verdictColors = {
      "Good deal": { color: "#15803d", bg: "rgba(21,128,61,0.08)", track: "#22c55e" },
      "Fairly priced": { color: "#1d4ed8", bg: "rgba(29,78,216,0.08)", track: "#6366f1" },
      "Possibly overpriced": { color: "#b45309", bg: "rgba(180,83,9,0.08)", track: "#f59e0b" },
      "Needs investigation": { color: "#b91c1c", bg: "rgba(185,28,28,0.08)", track: "#ef4444" },
    };
    const vc = verdictColors[data.verdict] || { color: "#475569", bg: "rgba(71,85,105,0.08)", track: "#94a3b8" };
    const score = safeScore(data.price_score);
    const circumference = 2 * Math.PI * 32; // r=32
    const offset = circumference - (score / 10) * circumference;

    // Red flags without emoji - SVG warning icon
    const warnIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
    const checkIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    const qIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

    const redFlags = (items) => items?.length
      ? items.map(i => `<div class="ll-flag-item ll-flag-danger"><div class="ll-flag-icon ll-flag-icon-danger">${warnIcon}</div><span>${escapeHtml(i)}</span></div>`).join("")
      : `<p class="ll-empty">None identified</p>`;

    const greenFlags = (items) => items?.length
      ? items.map(i => `<div class="ll-flag-item ll-flag-positive"><div class="ll-flag-icon ll-flag-icon-positive">${checkIcon}</div><span>${escapeHtml(i)}</span></div>`).join("")
      : `<p class="ll-empty">None identified</p>`;

    const questions = (items) => items?.length
      ? items.map(i => `<div class="ll-flag-item ll-flag-neutral"><div class="ll-flag-icon ll-flag-icon-neutral">${qIcon}</div><span>${escapeHtml(i)}</span></div>`).join("")
      : `<p class="ll-empty">None</p>`;

    // Pro-gated content: show a locked upsell instead of the real AI output
    // for non-Pro users, so the paywall actually restricts something.
    const proLock = (label) => `
      <div class="ll-pro-lock">
        <span class="ll-pro-lock-icon">🔒</span>
        <span class="ll-pro-lock-text">${label} is a Pro feature</span>
        <button class="ll-btn-secondary ll-pro-lock-btn" data-pro-upsell>Unlock Pro →</button>
      </div>`;

    // Tabs system
    el.innerHTML = `
      <!-- Hero Metric -->
      <div class="ll-hero" style="--hero-bg:${vc.bg};--hero-color:${vc.color};--hero-track:${vc.track}">
        <div class="ll-hero-glow"></div>
        <div class="ll-hero-inner">
          <div class="ll-hero-chart">
            <svg width="84" height="84" viewBox="0 0 84 84">
              <circle cx="42" cy="42" r="32" fill="none" stroke="#f1f5f9" stroke-width="5"/>
              <circle cx="42" cy="42" r="32" fill="none" stroke="${vc.track}" stroke-width="5"
                stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
                stroke-linecap="round" transform="rotate(-90 42 42)"
                style="transition:stroke-dashoffset 1s cubic-bezier(.25,.46,.45,.94);filter:drop-shadow(0 0 6px ${vc.track}66)"/>
            </svg>
            <div class="ll-hero-score">${score}<span>.0</span></div>
          </div>
          <div class="ll-hero-text">
            <div class="ll-hero-verdict" style="color:${vc.color}">${escapeHtml(data.verdict || "Analysis complete")}</div>
            <div class="ll-hero-reason">${escapeHtml(data.verdict_reason || "")}</div>
          </div>
        </div>
      </div>

      <!-- Segmented Tabs -->
      <div class="ll-tabs">
        <div class="ll-tab-slider" id="ll-tab-slider"></div>
        <button class="ll-tab active" data-tab="overview" data-idx="0">Overview</button>
        <button class="ll-tab" data-tab="offer" data-idx="1">Offer ${isPro ? "" : "🔒"}</button>
        <button class="ll-tab" data-tab="email" data-idx="2">Email</button>
      </div>

      <!-- Tab: Overview -->
      <div class="ll-tab-content" id="tab-overview">
        ${data.market_context ? `
        <div class="ll-card">
          <div class="ll-card-title">Market Context</div>
          <div class="ll-card-text">${escapeHtml(data.market_context)}</div>
        </div>` : ""}

        <div class="ll-card ll-card-danger">
          <div class="ll-card-title">Red Flags</div>
          <div class="ll-flags-list">${redFlags(data.red_flags)}</div>
        </div>

        <div class="ll-card ll-card-positive">
          <div class="ll-card-title">Positives</div>
          <div class="ll-flags-list">${greenFlags(data.green_flags)}</div>
        </div>

        <div class="ll-card">
          <div class="ll-card-title">Negotiation Tips</div>
          ${isPro
            ? `<div class="ll-flags-list">${data.negotiation_tips?.length
                ? data.negotiation_tips.map(t => `<div class="ll-flag-item ll-flag-positive"><div class="ll-flag-icon ll-flag-icon-positive">${checkIcon}</div><span>${escapeHtml(t)}</span></div>`).join("")
                : `<p class="ll-empty">Not enough data</p>`}
              </div>`
            : proLock("Negotiation Tips")}
        </div>

        <div class="ll-card ll-card-purple">
          <div class="ll-card-title">Comparable Sales</div>
          ${isPro
            ? `<div class="ll-card-text">${escapeHtml(data.comparable_note || "Not available")}</div>`
            : proLock("Comparable Sales")}
        </div>

        <div class="ll-card">
          <div class="ll-card-title">Ask the Seller</div>
          <div class="ll-flags-list">${questions(data.questions_to_ask)}</div>
        </div>
      </div>

      <!-- Tab: Offer -->
      <div class="ll-tab-content" id="tab-offer" style="display:none">
        <div class="ll-section">
          <div class="ll-section-title">📋 AI Offer Draft</div>
          ${isPro
            ? `<div class="ll-offer-box">${escapeHtml(data.offer_draft || "Not enough listing data to generate offer.")}</div>
               <button class="ll-btn-secondary" id="ll-copy-offer-btn">📋 Copy offer draft</button>`
            : proLock("Offer Draft")}
        </div>
      </div>

      <!-- Tab: Email -->
      <div class="ll-tab-content" id="tab-email" style="display:none">
        <div class="ll-section">
          <div class="ll-section-title">✉️ Draft client email</div>
          <div class="ll-email-box">${escapeHtml(data.client_email || "")}</div>
          <button class="ll-btn-secondary" id="ll-copy-email-btn">📋 Copy email</button>
        </div>
      </div>

      <!-- Actions -->
      <div class="ll-actions">
        <button class="${isPro ? "ll-btn-pdf" : "ll-btn-pdf ll-btn-locked"}" id="ll-pdf-btn">${isPro ? "📄 Download Report (HTML)" : "🔒 PDF Report — Pro"}</button>
        <button class="ll-btn-secondary" id="ll-reset-btn">← Analyze again</button>
      </div>

      <div class="ll-support">
        Questions? <span class="ll-support-email" id="ll-support-email" title="Click to copy">${SUPPORT_EMAIL}</span>
      </div>
    `;

    // Segmented tab switching with slider
    const tabsEl = el.querySelector(".ll-tabs");
    const slider = el.querySelector("#ll-tab-slider");
    function positionSlider(tabEl) {
      if (!slider || !tabsEl) return;
      const tabsRect = tabsEl.getBoundingClientRect();
      const tabRect = tabEl.getBoundingClientRect();
      slider.style.width = tabRect.width + "px";
      slider.style.transform = `translateX(${tabRect.left - tabsRect.left - 3}px)`;
    }
    el.querySelectorAll(".ll-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        el.querySelectorAll(".ll-tab").forEach(t => t.classList.remove("active"));
        el.querySelectorAll(".ll-tab-content").forEach(c => c.style.display = "none");
        tab.classList.add("active");
        document.getElementById(`tab-${tab.dataset.tab}`).style.display = "block";
        positionSlider(tab);
      });
    });
    // Initial slider position
    setTimeout(() => {
      const activeTab = el.querySelector(".ll-tab.active");
      if (activeTab) positionSlider(activeTab);
    }, 50);

    // Copy buttons
    document.getElementById("ll-copy-offer-btn")?.addEventListener("click", () => {
      navigator.clipboard.writeText(data.offer_draft || "");
      const b = document.getElementById("ll-copy-offer-btn");
      if (b) { b.textContent = "✓ Copied!"; setTimeout(() => { b.textContent = "📋 Copy offer draft"; }, 2000); }
    });
    document.getElementById("ll-copy-email-btn")?.addEventListener("click", () => {
      navigator.clipboard.writeText(data.client_email || "");
      const b = document.getElementById("ll-copy-email-btn");
      if (b) { b.textContent = "✓ Copied!"; setTimeout(() => { b.textContent = "📋 Copy email"; }, 2000); }
    });

    // PDF — Pro only; free users get sent to the upgrade flow instead
    document.getElementById("ll-pdf-btn")?.addEventListener("click", () => {
      if (isPro) {
        generatePDF(data, listing);
      } else {
        window.open(STRIPE_URL, "_blank");
      }
    });

    // Locked Pro sections' "Unlock Pro" buttons
    el.querySelectorAll("[data-pro-upsell]").forEach((btn) => {
      btn.addEventListener("click", () => window.open(STRIPE_URL, "_blank"));
    });

    document.getElementById("ll-reset-btn")?.addEventListener("click", resetToIdle);

    // Support email — copy on click
    document.getElementById("ll-support-email")?.addEventListener("click", () => {
      navigator.clipboard.writeText(SUPPORT_EMAIL);
      const el = document.getElementById("ll-support-email");
      if (el) { el.textContent = "✓ Copied!"; setTimeout(() => { el.textContent = SUPPORT_EMAIL; }, 2000); }
    });
  }

  // ─── 7. Sidebar HTML ─────────────────────────────────────────────────────

  function createSidebar() {
    if (document.getElementById(SIDEBAR_ID)) return;
    const sidebar = document.createElement("div");
    sidebar.id = SIDEBAR_ID;
    sidebar.innerHTML = `
      <div class="ll-header">
        <div class="ll-header-left">
          <div class="ll-header-dot"></div>
          <span class="ll-logo">🏠 ListingLens</span>
          <span class="ll-version-badge">2.0</span>
        </div>
        <button class="ll-close" id="ll-close-btn" title="Close">✕</button>
      </div>
      <div class="ll-body">
        <div id="ll-idle">
          <p class="ll-subtitle">AI-powered listing analysis</p>
          <button class="ll-btn-primary" id="ll-analyze-btn">
            <span>🔍 Analyze this listing</span>
          </button>
          <div class="ll-usage" id="ll-usage"></div>
          <div class="ll-features-mini">
            <span>Price score</span><span>·</span><span>Red flags</span><span>·</span>
            <span>Offer draft</span><span>·</span><span>PDF report</span>
          </div>
        </div>
        <div id="ll-loading" style="display:none">
          <div class="ll-spinner-wrap">
            <div class="ll-spinner"></div>
          </div>
          <p class="ll-loading-text">Analyzing with AI...</p>
          <p class="ll-loading-sub">Usually 3–8 seconds</p>
          <div class="ll-loading-steps">
            <div class="ll-step active" id="step1">📊 Reading listing data</div>
            <div class="ll-step" id="step2">🤖 Analyzing with AI</div>
            <div class="ll-step" id="step3">📋 Preparing report</div>
          </div>
        </div>
        <div id="ll-results" style="display:none"></div>
        <div id="ll-paywall" style="display:none">
          <div class="ll-paywall-icon">🔒</div>
          <p class="ll-paywall-title">Free analyses used up</p>
          <p class="ll-paywall-sub">Unlock unlimited analyses + all Pro features</p>
          <div class="ll-pro-features">
            <div class="ll-pro-feature">📋 Offer Generator</div>
            <div class="ll-pro-feature">🤝 Negotiation Tips</div>
            <div class="ll-pro-feature">📊 Comparable Sales</div>
            <div class="ll-pro-feature">📄 PDF Client Reports</div>
          </div>
          <button class="ll-btn-primary" id="ll-upgrade-btn">Start 7-day free trial — then $24/mo →</button>
          <div class="ll-divider">already subscribed? enter your email</div>
          <button class="ll-btn-secondary" id="ll-license-btn">Activate</button>
          <input class="ll-license-input" id="ll-license-input" type="email" placeholder="you@email.com" style="display:none" />
          <p class="ll-license-error" id="ll-license-error" style="display:none">No active subscription found for this email.</p>
        </div>
      </div>
      <div class="ll-sidebar-footer">
        <span class="ll-footer-email" id="ll-footer-email-copy" title="Click to copy">${SUPPORT_EMAIL}</span>
        <span class="ll-footer-sep">·</span>
        <a href="${STRIPE_URL}" target="_blank" class="ll-footer-link">Get Pro</a>
      </div>`;

    injectStyles();
    document.body.appendChild(sidebar);
    bindEvents(sidebar);
    refreshUsage();
    animateLoadingSteps();
  }

  // ─── 8. Loading animation ────────────────────────────────────────────────

  function animateLoadingSteps() {
    // Steps animate when loading is shown
  }

  function startLoadingAnimation() {
    const steps = ["step1", "step2", "step3"];
    let i = 0;
    steps.forEach(s => {
      const el = document.getElementById(s);
      if (el) el.className = "ll-step";
    });
    const interval = setInterval(() => {
      if (i > 0) {
        const prev = document.getElementById(steps[i - 1]);
        if (prev) prev.className = "ll-step done";
      }
      const curr = document.getElementById(steps[i]);
      if (curr) curr.className = "ll-step active";
      i++;
      if (i >= steps.length) clearInterval(interval);
    }, 1500);
    return interval;
  }

  // ─── 9. CSS ───────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById("ll-styles")) return;
    const s = document.createElement("style");
    s.id = "ll-styles";
    s.textContent = `
/* ══════════════════════════════════════════
   ListingLens 2.0 — Premium UI (per TZ)
   Style: Linear / Notion / Raycast
   ══════════════════════════════════════════ */

/* ── Sidebar shell ── */
#listinglens-sidebar{
  position:fixed;top:0;right:0;width:360px;height:100vh;
  background:#ffffff;
  box-shadow:-2px 0 0 rgba(0,0,0,.04),-8px 0 40px rgba(0,0,0,.12),-20px 0 80px rgba(29,78,216,.06);
  z-index:2147483647;display:flex;flex-direction:column;
  font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;
  font-size:14px;color:#0f172a;overflow:hidden;
}

/* ── Header — compact single line ── */
.ll-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:11px 14px;
  background:linear-gradient(135deg,#1e1b4b 0%,#312e81 45%,#1d4ed8 100%);
  position:relative;overflow:hidden;flex-shrink:0;
}
.ll-header::after{
  content:'';position:absolute;top:-40px;right:-30px;
  width:140px;height:140px;
  background:radial-gradient(circle,rgba(139,92,246,.35) 0%,transparent 65%);
  pointer-events:none;
}
.ll-header-left{display:flex;align-items:center;gap:7px;position:relative;z-index:1}
.ll-header-dot{
  width:6px;height:6px;border-radius:50%;background:#4ade80;flex-shrink:0;
  box-shadow:0 0 0 2px rgba(74,222,128,.25),0 0 8px rgba(74,222,128,.7);
  animation:ll-pulse-dot 2.5s ease-in-out infinite;
}
@keyframes ll-pulse-dot{
  0%,100%{box-shadow:0 0 0 2px rgba(74,222,128,.25),0 0 6px rgba(74,222,128,.6)}
  50%{box-shadow:0 0 0 3px rgba(74,222,128,.15),0 0 14px rgba(74,222,128,.9)}
}
.ll-logo{font-weight:700;font-size:14px;letter-spacing:-.2px;color:white}
.ll-version-badge{
  background:rgba(255,255,255,.12);backdrop-filter:blur(6px);
  font-size:9px;font-weight:700;color:rgba(255,255,255,.85);
  padding:2px 6px;border-radius:20px;letter-spacing:.4px;
}
.ll-close{
  background:transparent;border:none;color:rgba(255,255,255,.4);
  cursor:pointer;width:26px;height:26px;border-radius:6px;
  font-size:12px;display:flex;align-items:center;justify-content:center;
  transition:all .2s;position:relative;z-index:1;
}
.ll-close:hover{background:rgba(255,255,255,.15);color:white}

/* ── Body ── */
.ll-body{padding:14px;flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#e2e8f0 transparent}
.ll-subtitle{color:#64748b;font-size:12px;margin:0 0 14px;line-height:1.5}

/* ── Primary CTA button ── */
.ll-btn-primary{
  width:100%;padding:12px;
  background:linear-gradient(135deg,#1e1b4b,#312e81 50%,#1d4ed8);
  color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:700;
  cursor:pointer;transition:all .2s;
  box-shadow:0 2px 12px rgba(29,78,216,.35),0 1px 3px rgba(29,78,216,.2);
  display:flex;align-items:center;justify-content:center;gap:7px;
}
.ll-btn-primary:hover{
  transform:translateY(-1px);
  box-shadow:0 4px 18px rgba(29,78,216,.45),0 0 0 1px rgba(99,102,241,.2);
}
.ll-btn-primary:active{transform:translateY(0)}

/* ── Secondary button (outline) ── */
.ll-btn-secondary{
  width:100%;padding:9px;
  background:transparent;color:#475569;
  border:1px solid #e2e8f0;border-radius:8px;
  font-size:12px;font-weight:500;cursor:pointer;margin-top:6px;
  transition:all .15s;
}
.ll-btn-secondary:hover{background:#f8fafc;border-color:#cbd5e1;color:#0f172a}

/* ── PDF/Report button (secondary style) ── */
.ll-btn-pdf{
  width:100%;padding:9px;
  background:transparent;color:#7c3aed;
  border:1px solid #ede9fe;border-radius:8px;
  font-size:12px;font-weight:600;cursor:pointer;margin-top:6px;
  transition:all .15s;
}
.ll-btn-pdf:hover{background:#faf5ff;border-color:#c4b5fd}

/* ── Usage indicator ── */
.ll-usage{margin-top:10px;font-size:11px;color:#94a3b8;text-align:center}
.ll-features-mini{display:flex;flex-wrap:wrap;gap:4px;justify-content:center;margin-top:8px}
.ll-features-mini span{font-size:10px;color:#94a3b8;background:#f8fafc;padding:3px 8px;border-radius:20px}
.ll-features-mini span:nth-child(even){display:none}

/* ── Loading state ── */
#ll-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:36px 16px;text-align:center}
.ll-spinner-wrap{
  width:48px;height:48px;border-radius:14px;
  background:linear-gradient(135deg,#eff6ff,#e0e7ff);
  display:flex;align-items:center;justify-content:center;
  box-shadow:0 2px 12px rgba(99,102,241,.15);
}
.ll-spinner{
  width:24px;height:24px;
  border:2.5px solid #e0e7ff;border-top-color:#6366f1;
  border-radius:50%;animation:ll-spin .65s linear infinite;
}
@keyframes ll-spin{to{transform:rotate(360deg)}}
.ll-loading-text{font-size:13px;font-weight:600;color:#0f172a}
.ll-loading-sub{font-size:11px;color:#94a3b8}
.ll-loading-steps{width:100%;display:flex;flex-direction:column;gap:5px;margin-top:4px}
.ll-step{
  font-size:11px;padding:7px 11px;border-radius:8px;
  background:#f8fafc;color:#94a3b8;transition:all .35s;text-align:left;
}
.ll-step.active{
  background:linear-gradient(135deg,#eff6ff,#e0e7ff);
  color:#4338ca;font-weight:600;
  box-shadow:0 1px 4px rgba(99,102,241,.1);
}
.ll-step.done{background:#f0fdf4;color:#15803d}

/* ── Verdict card ── */
.ll-verdict{
  background:#fafafa;border-left:3px solid #6366f1;
  border-radius:12px;padding:14px 14px 12px;margin-bottom:14px;
  box-shadow:0 1px 3px rgba(0,0,0,.05),0 4px 16px rgba(0,0,0,.03);
}
.ll-verdict-label{font-weight:800;font-size:16px;margin-bottom:6px;letter-spacing:-.2px}
.ll-verdict-reason{font-size:12px;color:#475569;line-height:1.6;margin-bottom:10px}
.ll-score-bar{height:5px;background:#f1f5f9;border-radius:3px;overflow:hidden;margin-bottom:4px}
.ll-score-fill{height:100%;border-radius:3px;transition:width .9s cubic-bezier(.25,.46,.45,.94)}
.ll-score-label{font-size:10px;color:#94a3b8;font-weight:500}

/* ── Tabs ── */
.ll-tabs{
  display:flex;gap:2px;margin-bottom:14px;
  background:#f1f5f9;border-radius:10px;padding:3px;
}
.ll-tab{
  flex:1;padding:7px;border:none;background:transparent;
  border-radius:8px;font-size:11px;font-weight:600;color:#64748b;
  cursor:pointer;transition:all .2s;
}
.ll-tab.active{
  background:white;color:#0f172a;
  box-shadow:0 1px 4px rgba(0,0,0,.1),0 1px 2px rgba(0,0,0,.06);
}
.ll-tab-content{animation:ll-fadein .18s ease}
@keyframes ll-fadein{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}

/* ── Sections ── */
.ll-section{margin-bottom:16px}
.ll-section-title{
  font-weight:600;font-size:10px;text-transform:uppercase;
  letter-spacing:.7px;color:#94a3b8;margin-bottom:8px;
}
.ll-market-note{
  font-size:12px;color:#334155;line-height:1.6;
  background:#f8fafc;border-radius:8px;padding:10px 12px;
}
.ll-flags{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px}
.ll-flags li{
  font-size:12px;line-height:1.5;padding:8px 11px;border-radius:8px;
  display:flex;align-items:flex-start;gap:7px;
}
.ll-flag-red{background:#fff5f5;color:#7f1d1d}
.ll-flag-green{background:#f0fdf4;color:#14532d}
.ll-flag-neutral{background:#f8fafc;color:#334155}
.ll-empty{font-size:11px;color:#94a3b8;font-style:italic;padding:4px 2px}

/* ── AI content boxes (shimmer on load) ── */
.ll-offer-box{
  background:linear-gradient(135deg,#f5f3ff,#ede9fe);
  border-radius:10px;padding:13px;
  font-size:12px;line-height:1.7;color:#3730a3;
  white-space:pre-wrap;margin-bottom:8px;
}
.ll-email-box{
  background:#f8fafc;border-radius:10px;padding:13px;
  font-size:12px;line-height:1.7;color:#334155;
  white-space:pre-wrap;margin-bottom:8px;
}

/* ── Shimmer animation for AI content ── */
@keyframes ll-shimmer{
  0%{background-position:-600px 0}
  100%{background-position:600px 0}
}
.ll-shimmer{
  background:linear-gradient(90deg,#f1f5f9 25%,#e2e8f0 50%,#f1f5f9 75%);
  background-size:600px 100%;
  animation:ll-shimmer 1.5s ease-in-out infinite;
  border-radius:6px;height:12px;margin-bottom:8px;
}

/* ── Actions ── */
.ll-actions{margin-top:10px;display:flex;flex-direction:column;gap:0}

/* ── Paywall ── */
#ll-paywall{
  display:flex;flex-direction:column;align-items:center;
  text-align:center;padding:20px 4px;gap:8px;
}
.ll-paywall-icon{font-size:30px;margin-bottom:2px}
.ll-paywall-title{font-size:15px;font-weight:700;color:#0f172a;letter-spacing:-.2px}
.ll-paywall-sub{font-size:12px;color:#64748b;line-height:1.5;max-width:260px}
.ll-pro-features{
  display:grid;grid-template-columns:1fr 1fr;gap:5px;
  width:100%;margin:6px 0;
}
.ll-pro-feature{
  background:#f0fdf4;border-radius:8px;padding:8px 10px;
  font-size:11px;color:#166534;font-weight:500;text-align:left;
}
.ll-divider{font-size:11px;color:#cbd5e1;width:100%;text-align:center;margin:2px 0}
.ll-license-input{
  width:100%;padding:10px 12px;
  border:1px solid #e2e8f0;border-radius:8px;
  font-size:12px;margin-top:6px;outline:none;
  font-family:monospace;background:white;color:#0f172a;
  transition:border-color .15s,box-shadow .15s;
}
.ll-license-input:focus{
  border-color:#6366f1;
  box-shadow:0 0 0 3px rgba(99,102,241,.1);
}
.ll-license-error{font-size:11px;color:#dc2626;margin-top:5px}

/* ── Upgrade button in paywall ── */
.ll-btn-primary.ll-paywall-upgrade{
  background:linear-gradient(135deg,#1e1b4b,#4338ca);
}

/* ── Error ── */
.ll-error{
  background:#fff5f5;color:#7f1d1d;border-radius:10px;
  padding:12px;font-size:12px;line-height:1.6;
}
.ll-support-note{font-size:11px;color:#94a3b8;margin:8px 0;text-align:center}

/* ── Sidebar footer ── */
.ll-sidebar-footer{
  display:flex;align-items:center;justify-content:center;gap:8px;
  padding:9px 14px;background:white;flex-shrink:0;
  border-top:1px solid rgba(0,0,0,.04);
}
.ll-footer-link{
  font-size:10px;color:#94a3b8;text-decoration:none;
  background:none;border:none;cursor:pointer;font-family:inherit;
  padding:3px 6px;border-radius:5px;transition:all .15s;
  position:relative;
}
.ll-footer-link:hover{color:#1d4ed8;background:#eff6ff}
.ll-footer-link::after{
  content:attr(data-tooltip);
  position:absolute;bottom:calc(100% + 6px);left:50%;
  transform:translateX(-50%);
  background:#0f172a;color:white;font-size:10px;
  padding:4px 8px;border-radius:6px;white-space:nowrap;
  opacity:0;pointer-events:none;transition:opacity .15s;
}
.ll-footer-link:hover::after{opacity:1}
.ll-footer-sep{font-size:10px;color:#e2e8f0}

/* ── Support email ── */
.ll-support{font-size:10px;color:#94a3b8;text-align:center;margin-top:14px;padding-top:10px}
.ll-support-email{
  color:#6366f1;cursor:pointer;font-family:monospace;font-size:10px;
  text-decoration:underline;text-decoration-style:dotted;
  transition:color .15s;
}
.ll-support-email:hover{color:#4338ca}

/* ══ HERO METRIC ══ */
.ll-hero{
  position:relative;border-radius:14px;
  background:var(--hero-bg,rgba(29,78,216,0.06));
  padding:16px 14px;margin-bottom:14px;overflow:hidden;
}
.ll-hero-glow{
  position:absolute;top:-20px;right:-20px;
  width:120px;height:120px;border-radius:50%;
  background:radial-gradient(circle,var(--hero-track,#6366f1) 0%,transparent 70%);
  opacity:.12;pointer-events:none;
}
.ll-hero-inner{display:flex;align-items:center;gap:14px}
.ll-hero-chart{position:relative;width:84px;height:84px;flex-shrink:0}
.ll-hero-score{
  position:absolute;top:50%;left:50%;
  transform:translate(-50%,-50%);
  font-size:20px;font-weight:800;color:var(--hero-color,#1d4ed8);
  line-height:1;letter-spacing:-.5px;
  display:flex;align-items:baseline;gap:1px;
}
.ll-hero-score span{font-size:11px;font-weight:500;opacity:.6}
.ll-hero-text{flex:1;min-width:0}
.ll-hero-verdict{
  font-size:18px;font-weight:800;color:var(--hero-color,#1d4ed8);
  letter-spacing:-.4px;margin-bottom:6px;line-height:1.2;
}
.ll-hero-reason{font-size:11.5px;color:#475569;line-height:1.6}

/* ══ SEGMENTED TABS ══ */
.ll-tabs{
  position:relative;display:flex;
  background:#f1f5f9;border-radius:10px;padding:3px;
  margin-bottom:14px;
}
.ll-tab-slider{
  position:absolute;top:3px;left:3px;
  height:calc(100% - 6px);
  background:white;border-radius:8px;
  box-shadow:0 1px 4px rgba(0,0,0,.1),0 1px 2px rgba(0,0,0,.06);
  transition:transform .22s cubic-bezier(.25,.46,.45,.94),width .22s cubic-bezier(.25,.46,.45,.94);
  pointer-events:none;z-index:0;
}
.ll-tab{
  flex:1;padding:7px;border:none;background:transparent;
  border-radius:8px;font-size:11px;font-weight:600;color:#94a3b8;
  cursor:pointer;transition:color .2s;position:relative;z-index:1;
}
.ll-tab.active{color:#0f172a}

/* ══ CONTENT CARDS ══ */
.ll-card{
  background:#fafafa;border-radius:12px;
  padding:12px 13px;margin-bottom:10px;
}
.ll-card-danger{background:#fffbfb;border-left:3px solid #fca5a5}
.ll-card-positive{background:#f9fffe;border-left:3px solid #86efac}
.ll-card-purple{background:#faf8ff;border-left:3px solid #c4b5fd}
.ll-card-title{
  font-size:13px;font-weight:700;color:#0f172a;
  margin-bottom:8px;letter-spacing:-.1px;
}
.ll-card-text{font-size:12px;color:#475569;line-height:1.6}

/* ══ NEW FLAG ITEMS ══ */
.ll-flags-list{display:flex;flex-direction:column;gap:6px}
.ll-flag-item{
  display:flex;align-items:flex-start;gap:9px;
  font-size:12px;line-height:1.5;
}
.ll-flag-icon{
  flex-shrink:0;width:20px;height:20px;
  border-radius:6px;display:flex;align-items:center;justify-content:center;
  margin-top:1px;
}
.ll-flag-icon-danger{background:#fef2f2;color:#dc2626}
.ll-flag-icon-positive{background:#f0fdf4;color:#16a34a}
.ll-flag-icon-neutral{background:#f1f5f9;color:#64748b}
.ll-flag-danger span{color:#374151}
.ll-flag-positive span{color:#374151}
.ll-flag-neutral span{color:#374151}
.ll-empty{font-size:11px;color:#94a3b8;font-style:italic;padding:2px 0}

/* ── Footer email ── */
.ll-footer-email{
  font-size:10px;color:#6366f1;font-family:monospace;
  cursor:pointer;transition:color .15s;
  padding:3px 6px;border-radius:5px;
}
.ll-footer-email:hover{color:#4338ca;background:#eff6ff}

/* ── Pro-locked section ── */
.ll-pro-lock{
  display:flex;flex-direction:column;align-items:center;gap:6px;
  padding:16px 10px;text-align:center;
}
.ll-pro-lock-icon{font-size:18px}
.ll-pro-lock-text{font-size:12px;color:#94a3b8;font-weight:600}
.ll-pro-lock-btn{
  width:auto;padding:7px 14px;margin-top:2px;
  color:#4338ca;border-color:#c7d2fe;font-weight:700;
}
.ll-pro-lock-btn:hover{background:#eef2ff;border-color:#a5b4fc}
.ll-btn-pdf.ll-btn-locked{color:#94a3b8;border-color:#e2e8f0}
.ll-btn-pdf.ll-btn-locked:hover{background:#f8fafc;border-color:#cbd5e1}

/* ── Toggle button ── */
#ll-toggle-btn{
  position:fixed;bottom:20px;right:20px;z-index:2147483646;
  background:linear-gradient(135deg,#1e1b4b,#312e81 50%,#1d4ed8);
  color:#fff;border:none;border-radius:24px;
  padding:10px 16px;font-size:13px;font-weight:700;
  cursor:pointer;
  box-shadow:0 4px 20px rgba(29,78,216,.45),0 1px 4px rgba(0,0,0,.1);
  transition:all .2s;
}
#ll-toggle-btn:hover{
  transform:translateY(-2px);
  box-shadow:0 8px 28px rgba(29,78,216,.55);
}
    `;
    document.head.appendChild(s);
  }

  // ─── 10. Usage helpers ────────────────────────────────────────────────────

  async function getUsageCount() {
    const { llUsage = 0 } = await chrome.storage.local.get("llUsage");
    return llUsage;
  }
  async function bumpUsage() {
    const n = await getUsageCount();
    await chrome.storage.local.set({ llUsage: n + 1 });
  }
  async function checkUnlocked() {
    const { llProActive = false } = await chrome.storage.local.get("llProActive");
    return llProActive;
  }

  // Verify the saved email against Stripe via the Worker.
  // Returns true if an active/trialing subscription exists.
  async function verifySubscription(email) {
    try {
      const res = await fetch(`${WORKER_URL}/check-subscription`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      const active = !!data.active;
      await chrome.storage.local.set({ llProActive: active, llEmail: active ? email : "" });
      return active;
    } catch {
      return false;
    }
  }
  async function refreshUsage() {
    const el = document.getElementById("ll-usage");
    if (!el) return;
    if (await checkUnlocked()) {
      el.innerHTML = `<span style="color:#16a34a;font-weight:600">⭐ Pro — unlimited analyses</span>`;
    } else {
      const used = await getUsageCount();
      const left = Math.max(0, FREE_LIMIT - used);
      el.textContent = left > 0 ? `${left} free ${left === 1 ? "analysis" : "analyses"} remaining` : "Free analyses used up";
      if (left === 0) el.style.color = "#dc2626";
    }
  }

  // ─── 11. State helpers ────────────────────────────────────────────────────

  const show = (id) => { const e = document.getElementById(id); if (e) e.style.display = ""; };
  const hide = (id) => { const e = document.getElementById(id); if (e) e.style.display = "none"; };

  let loadingInterval = null;
  function showLoading() {
    hide("ll-idle"); show("ll-loading"); hide("ll-results"); hide("ll-paywall");
    loadingInterval = startLoadingAnimation();
  }
  function showResults() {
    if (loadingInterval) clearInterval(loadingInterval);
    hide("ll-loading"); show("ll-results"); hide("ll-paywall"); hide("ll-idle");
  }
  function showPaywall() { hide("ll-idle"); hide("ll-loading"); hide("ll-results"); show("ll-paywall"); }
  function resetToIdle() { show("ll-idle"); hide("ll-loading"); hide("ll-results"); hide("ll-paywall"); refreshUsage(); }

  // ─── 12. Event bindings ───────────────────────────────────────────────────

  function bindEvents(sidebar) {
    document.getElementById("ll-analyze-btn")?.addEventListener("click", async () => {
      showLoading();
      const listing = scrapeListing();
      try {
        const [analysis, isPro] = await Promise.all([analyzeListing(listing), checkUnlocked()]);
        await bumpUsage();
        renderResults(analysis, listing, isPro);
        showResults();
      } catch (err) {
        if (err.message === "__PAYWALL__") { showPaywall(); return; }
        renderResults({ error: `Error: ${err.message}` }, listing, false);
        showResults();
      }
    });

    document.getElementById("ll-close-btn")?.addEventListener("click", () => {
      sidebar.style.display = "none";
      const t = document.getElementById("ll-toggle-btn");
      if (t) { t.textContent = "🏠 ListingLens"; t.style.display = "flex"; }
    });

    document.getElementById("ll-upgrade-btn")?.addEventListener("click", () => {
      window.open(STRIPE_URL, "_blank");
    });

    // Footer email copy
    document.getElementById("ll-footer-email-copy")?.addEventListener("click", () => {
      navigator.clipboard.writeText(SUPPORT_EMAIL);
      const el = document.getElementById("ll-footer-email-copy");
      if (el) { el.textContent = "✓ Copied!"; setTimeout(() => { el.textContent = SUPPORT_EMAIL; }, 2000); }
    });

    document.getElementById("ll-license-btn")?.addEventListener("click", async () => {
      const input = document.getElementById("ll-license-input");
      const errEl = document.getElementById("ll-license-error");
      const btn = document.getElementById("ll-license-btn");
      if (!input) return;
      if (input.style.display === "none") {
        input.style.display = "block";
        input.focus();
        btn.textContent = "✓ Activate";
      } else {
        const email = input.value.trim().toLowerCase();
        if (!email || !email.includes("@")) {
          if (errEl) { errEl.textContent = "Please enter a valid email."; errEl.style.display = "block"; }
          return;
        }
        btn.textContent = "Checking…";
        btn.disabled = true;
        const ok = await verifySubscription(email);
        btn.disabled = false;
        btn.textContent = "✓ Activate";
        if (ok) {
          if (errEl) errEl.style.display = "none";
          resetToIdle();
        } else {
          if (errEl) { errEl.textContent = "No active subscription found for this email."; errEl.style.display = "block"; }
        }
      }
    });
  }

  // ─── 13. Toggle button ────────────────────────────────────────────────────

  function injectToggle() {
    if (document.getElementById("ll-toggle-btn")) return;
    const btn = document.createElement("button");
    btn.id = "ll-toggle-btn";
    btn.textContent = "🏠 ListingLens";
    btn.title = "Open ListingLens";
    btn.addEventListener("click", () => {
      const s = document.getElementById(SIDEBAR_ID);
      if (!s) return;
      const hidden = s.style.display === "none";
      s.style.display = hidden ? "flex" : "none";
      btn.textContent = hidden ? "✕ Close" : "🏠 ListingLens";
    });
    document.body.appendChild(btn);
  }

  // ─── 14. Init — robust startup ────────────────────────────────────────────

  let initialized = false;

  function init() {
    if (initialized) return;
    if (!document.body) {
      // body not ready — retry shortly
      setTimeout(init, 200);
      return;
    }
    if (document.getElementById(SIDEBAR_ID)) { initialized = true; return; }
    initialized = true;
    createSidebar();
    injectToggle();
  }

  // Try init — works regardless of readyState
  function tryInit() {
    init();
  }

  // Expose init for background.js re-injection
  window.__listingLensInit = function() {
    window.__listingLensLastUrl = window.location.href;
    document.getElementById(SIDEBAR_ID)?.remove();
    document.getElementById("ll-toggle-btn")?.remove();
    document.getElementById("ll-styles")?.remove();
    initialized = false;
    setTimeout(init, 300);
  };

  // Immediate attempt (works if document_end fires after body exists)
  tryInit();

  // On DOM ready
  document.addEventListener("DOMContentLoaded", tryInit);

  // On full load
  window.addEventListener("load", tryInit);

  // Fallback retries — Zillow has heavy SPA navigation and SSR hydration
  setTimeout(tryInit, 300);
  setTimeout(tryInit, 800);
  setTimeout(tryInit, 1500);
  setTimeout(tryInit, 3000);

  // SPA navigation — detect URL changes (Zillow navigates without reload)
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      window.__listingLensLastUrl = location.href;
      document.getElementById(SIDEBAR_ID)?.remove();
      document.getElementById("ll-toggle-btn")?.remove();
      document.getElementById("ll-styles")?.remove();
      initialized = false;
      setTimeout(init, 500);
      setTimeout(init, 1500);
      setTimeout(init, 3000);
    }
  }).observe(document.documentElement, { subtree: true, childList: true });
})();
} // end guard
