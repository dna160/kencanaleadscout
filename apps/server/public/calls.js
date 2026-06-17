/* Kencana LeadScout — rep call cockpit (microPRD §16). Framework-free. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const ROLE_KEY = "kls_role";

  const DAY_FOCUS = {
    1: "Prove on best fit", 2: "Finish P0, build P1", 3: "P1 core baseline",
    4: "P1 core baseline", 5: "P1 core baseline", 6: "Introduce P2",
    7: "First tier comparison", 8: "P2 heavy + P3 probe", 9: "Sharpen comparison",
    10: "Cleanup + review prep",
  };
  const STATUS_LABEL = {
    won_wa: "WA captured", warm: "Warm", not_interested: "Not interested",
    no_answer: "No answer", dead: "Dead number",
  };

  const state = { role: null, day: null, leads: [], idx: 0 };
  const DISPLAY_ROLE = { "Rep A": "Hunter A", "Rep B": "Hunter B" };
  const displayRole = (role) => DISPLAY_ROLE[role] || role;

  /* ---------- view switching ---------- */
  function show(id) {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    $(id).classList.add("active");
    window.scrollTo(0, 0);
  }

  /* ---------- gate ---------- */
  document.querySelectorAll(".role").forEach((el) =>
    el.addEventListener("click", () => pickRole(el.dataset.role)),
  );
  function pickRole(role) {
    if (role === "Champion") { location.href = "/champion"; return; }
    if (role === "Handler") { location.href = "/handler"; return; }
    if (role === "Sales Lead") { location.href = "/sales-lead"; return; }
    localStorage.setItem(ROLE_KEY, role);
    state.role = role;
    enterDays();
  }
  $("switchRole").addEventListener("click", () => { localStorage.removeItem(ROLE_KEY); show("gate"); });

  /* ---------- day picker ---------- */
  async function enterDays() {
    $("dWho").textContent = displayRole(state.role);
    show("days");
    const grid = $("dayGrid");
    grid.innerHTML = "";
    const cards = [];
    for (let d = 1; d <= 10; d++) {
      const card = document.createElement("div");
      card.className = "day";
      card.innerHTML =
        `<div class="d">Day ${d}</div><div class="focus">${DAY_FOCUS[d]}</div>` +
        `<div class="mini"><div></div></div><div class="stat">—</div>`;
      card.addEventListener("click", () => enterCockpit(d));
      grid.appendChild(card);
      cards.push(card);
    }
    // Fill per-day progress in parallel (counts only).
    for (let d = 1; d <= 10; d++) {
      fetchLeads(state.role, d)
        .then((leads) => {
          const total = leads.length || 30;
          const worked = leads.filter((l) => l.outcome).length;
          const won = leads.filter((l) => l.outcome && l.outcome.status === "won_wa").length;
          cards[d - 1].querySelector(".mini > div").style.width = `${Math.round((worked / total) * 100)}%`;
          cards[d - 1].querySelector(".stat").textContent =
            worked === 0 ? `${total} leads` : `${worked}/${total} worked · ${won} captured`;
        })
        .catch(() => {});
    }
  }

  /* ---------- data ---------- */
  async function fetchLeads(rep, day) {
    const res = await fetch(`/api/leads?rep=${encodeURIComponent(rep)}&day=${day}`);
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || "Failed to load leads");
    }
    const data = await res.json();
    return data.leads;
  }

  async function enterCockpit(day) {
    state.day = day;
    show("cockpit");
    $("leadBody").innerHTML = '<div class="loading">Loading leads…</div>';
    $("actions").style.display = "none";
    try {
      state.leads = await fetchLeads(state.role, day);
    } catch (err) {
      $("leadBody").innerHTML = `<div class="loading">${err.message}.<br/>Is the database configured?</div>`;
      return;
    }
    // Resume: first lead without an outcome.
    const firstOpen = state.leads.findIndex((l) => !l.outcome);
    if (firstOpen === -1 && state.leads.length) { showComplete(); return; }
    state.idx = firstOpen === -1 ? 0 : firstOpen;
    $("actions").style.display = "block";
    renderLead();
  }

  /* ---------- helpers ---------- */
  function firstTel(landline) {
    const first = String(landline || "").split("/")[0].trim();
    return first;
  }
  function telHref(landline) {
    return firstTel(landline).replace(/[^\d+]/g, "");
  }
  function withProtocol(url) {
    const u = String(url || "").trim();
    if (!u) return "";
    return /^https?:\/\//i.test(u) ? u : "https://" + u;
  }
  function linkedinUrl(company, ask) {
    const kw = [ask, company].filter(Boolean).join(" ").trim();
    return "https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent(kw);
  }
  function normalizeWa(raw) {
    let c = String(raw || "").replace(/[^\d+]/g, "");
    if (!c) return "";
    if (c.startsWith("+")) return c;
    if (c.startsWith("62")) return "+" + c;
    if (c.startsWith("0")) return "+62" + c.slice(1);
    if (c.startsWith("8")) return "+62" + c;
    return "+" + c;
  }
  const WA_RE = /^\+628\d{7,11}$/;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---------- render one lead ---------- */
  function renderLead() {
    const lead = state.leads[state.idx];
    const total = state.leads.length;
    const worked = state.leads.filter((l) => l.outcome).length;

    $("cWho").textContent = `${displayRole(state.role).toUpperCase()} · DAY ${state.day}`;
    $("cIdx").textContent = String(state.idx + 1).padStart(2, "0");
    $("cTotal").textContent = total;
    $("cFill").style.width = `${Math.round((worked / total) * 100)}%`;

    const tel = firstTel(lead.landline);
    const scrapedWa = lead.scraped && lead.scraped.wa_numbers && lead.scraped.wa_numbers[0];
    const existing = lead.outcome || null;
    const prefillWa = (existing && existing.wa_number) || scrapedWa || "";
    const website = withProtocol(lead.website);
    const scriptOpen = state.idx === 0 || !existing;

    $("leadBody").innerHTML = `
      <div>
        <span class="tier ${esc(lead.priority)}">${esc(lead.priority)} TIER</span>
        <span class="done-flag ${existing ? "show" : ""}">✓ ${existing ? esc(STATUS_LABEL[existing.status] || existing.status) : ""}</span>
      </div>
      <div class="company">${esc(lead.company)}</div>
      <div class="meta"><b>${esc(lead.town)}</b>${lead.province ? " · " + esc(lead.province) : ""} · ${esc(lead.role || "")}</div>

      <div class="askbox">
        <div class="l">Ask for</div>
        <div class="n">${esc(lead.ask_for || "—")}</div>
        <div class="r">${esc(lead.role || "")}</div>
      </div>

      <a class="callbtn" href="tel:${esc(telHref(lead.landline))}">
        <span class="ph">📞</span><span>${esc(tel || "No number")}</span>
      </a>

      <div class="xcheck">
        <a class="xbtn li" href="${esc(linkedinUrl(lead.company, lead.ask_for))}" target="_blank" rel="noopener">in · Verify</a>
        <a class="xbtn" href="${website || "#"}" target="_blank" rel="noopener" ${website ? "" : 'aria-disabled="true"'}>🌐 Site</a>
        <a class="xbtn" href="${lead.email ? "mailto:" + esc(lead.email) : "#"}" ${lead.email ? "" : 'aria-disabled="true"'}>✉ Email</a>
      </div>
      <div class="xhint">Cross-check on LinkedIn first — confirm the person &amp; role before you pitch.</div>

      <details class="script" ${scriptOpen ? "open" : ""}>
        <summary>What to say <span class="chev">▾</span></summary>
        <div class="body">
          "Selamat pagi, dengan <b>${esc(lead.company)}</b>? Boleh bicara dengan Bapak/Ibu
          <b>${esc(lead.ask_for || "yang bertugas")}</b>? … Saya dari Kencana Panelindo, pabrik ACP lokal
          pertama di Indonesia. Kami ada <b>sample ACP gratis + spec sheet</b> untuk proyek facade.
          <b>Boleh saya kirim via WhatsApp? Nomor WA aktifnya di nomor berapa ya?</b>"
        </div>
      </details>

      <div class="capture">
        <div class="field">
          <div class="label">WhatsApp number ${scrapedWa && !(existing && existing.wa_number) ? '<span class="scraped">scraped</span>' : ""}</div>
          <input id="waInput" type="tel" inputmode="tel" placeholder="+62 8xx xxxx xxxx" value="${esc(prefillWa)}" />
          <div class="inline-err" id="waErr">Enter a valid Indonesian mobile (+628…).</div>
        </div>
        <div class="field">
          <div class="label">PIC name (optional)</div>
          <input id="picInput" type="text" placeholder="Fill only if a different person answered" value="${esc(existing && existing.pic_name || "")}" />
        </div>
        <div class="toggle">
          <span>Sample sent</span>
          <div class="sw ${existing && existing.sample_sent ? "on" : ""}" id="sampleSw" role="switch" aria-checked="${existing && existing.sample_sent ? "true" : "false"}"></div>
        </div>

        <div class="chips" id="chips">
          ${chip("won", "won_wa", "✅ WA captured", existing)}
          ${chip("warm", "warm", "🔥 Warm — call back", existing)}
          ${chip("ni", "not_interested", "🚫 Not interested", existing)}
          ${chip("na", "no_answer", "☎️ No answer", existing)}
          ${chip("dead", "dead", "❌ Dead number", existing, true)}
        </div>
      </div>`;

    wireLead(existing);
  }

  function chip(cls, status, label, existing, span2) {
    const sel = existing && existing.status === status ? "sel" : "";
    return `<div class="chip ${cls} ${span2 ? "span2" : ""} ${sel}" data-status="${status}">${label}</div>`;
  }

  /* ---------- wire interactions for the current lead ---------- */
  let chosenStatus = null;
  let sampleSent = false;

  function wireLead(existing) {
    chosenStatus = existing ? existing.status : null;
    sampleSent = !!(existing && existing.sample_sent);

    const sw = $("sampleSw");
    sw.addEventListener("click", () => {
      sampleSent = !sampleSent;
      sw.classList.toggle("on", sampleSent);
      sw.setAttribute("aria-checked", String(sampleSent));
    });

    $("chips").querySelectorAll(".chip").forEach((c) =>
      c.addEventListener("click", () => {
        $("chips").querySelectorAll(".chip").forEach((x) => x.classList.remove("sel"));
        c.classList.add("sel");
        chosenStatus = c.dataset.status;
        $("waErr").classList.remove("show");
        $("waInput").classList.remove("bad");
        if (chosenStatus === "won_wa") $("waInput").focus();
        updateSaveState();
      }),
    );

    $("waInput").addEventListener("input", () => { $("waInput").classList.remove("bad"); $("waErr").classList.remove("show"); });

    updateSaveState();
    $("backBtn").disabled = state.idx === 0;
    $("skipBtn").disabled = state.idx >= state.leads.length - 1;
  }

  function updateSaveState() { $("saveBtn").disabled = !chosenStatus; }

  /* ---------- actions ---------- */
  $("saveBtn").addEventListener("click", saveAndNext);
  $("backBtn").addEventListener("click", () => { if (state.idx > 0) { state.idx--; renderLead(); } });
  $("skipBtn").addEventListener("click", () => { if (state.idx < state.leads.length - 1) { state.idx++; renderLead(); } });
  $("backToDays").addEventListener("click", enterDays);

  async function saveAndNext() {
    const lead = state.leads[state.idx];
    if (!chosenStatus) return;

    let waNumber = null;
    if (chosenStatus === "won_wa") {
      waNumber = normalizeWa($("waInput").value);
      if (!WA_RE.test(waNumber)) {
        $("waInput").classList.add("bad");
        $("waErr").classList.add("show");
        $("waInput").focus();
        return;
      }
    }

    const payload = {
      lead_id: lead.id,
      status: chosenStatus,
      wa_number: waNumber,
      pic_name: $("picInput").value.trim() || null,
      sample_sent: sampleSent,
      updated_by: state.role,
    };

    const btn = $("saveBtn");
    btn.disabled = true; btn.textContent = "Saving…";
    let res;
    try { res = await fetch("/api/outcome", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); }
    catch { btn.disabled = false; btn.textContent = "Save & next →"; alert("Network error — try again."); return; }

    const data = await res.json().catch(() => ({}));
    btn.textContent = "Save & next →";
    if (!res.ok) { btn.disabled = false; alert(data.error || "Could not save."); return; }

    lead.outcome = {
      status: chosenStatus, wa_number: waNumber, pic_name: payload.pic_name,
      sample_sent: sampleSent, updated_by: state.role, updated_at: new Date().toISOString(),
    };

    // Advance to next unworked lead; if none, day complete.
    const nextOpen = findNextOpen(state.idx);
    if (nextOpen === -1) { showComplete(); return; }
    state.idx = nextOpen;
    renderLead();
  }

  function findNextOpen(from) {
    for (let i = from + 1; i < state.leads.length; i++) if (!state.leads[i].outcome) return i;
    for (let i = 0; i < state.leads.length; i++) if (!state.leads[i].outcome) return i;
    return -1;
  }

  /* ---------- day complete ---------- */
  function showComplete() {
    const dialed = state.leads.filter((l) => l.outcome).length;
    const captured = state.leads.filter((l) => l.outcome && l.outcome.status === "won_wa").length;
    const rate = dialed ? Math.round((captured / dialed) * 100) : 0;
    $("xWho").textContent = `${displayRole(state.role).toUpperCase()} · DAY ${state.day}`;
    $("xDialed").textContent = dialed;
    $("xCaptured").textContent = captured;
    $("xRate").textContent = rate + "%";
    show("complete");
  }

  /* ---------- boot ---------- */
  const saved = localStorage.getItem(ROLE_KEY);
  if (saved === "Rep A" || saved === "Rep B") { state.role = saved; enterDays(); }
  else show("gate");
})();
