/*
  Trip Planner
  Day cards (left) and an hour-by-hour schedule (right) are two views of one trip object, S.
  Every edit changes S and re-renders; a draft is kept in this browser, and trips are saved/opened as JSON.

  Sections, in order:
     1. Constants and state
     2. Formatting helpers
     3. Trip model: days and blocks
     4. Rendering
     5. Plan rows in the day cards (each row is a schedule block)
     6. New-row drafts: nothing touches the schedule until Confirm
     7. Rich-text notes
     8. Places: add and rename
     9. Focus and highlighting between the day cards and the schedule
    10. Schedule: drag on empty space to create a block
    11. Schedule: resize, move and Shift-select blocks
    12. Popovers: dropdown lists, date picker and color picker
    13. Undo and redo (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y)
    14. Saving and files
    15. Page-wide event handlers
    16. Boot
*/
(function () {
  "use strict";

  /* ===== 1. Constants and state ===== */

  const H0 = 5,
    H1 = 24;

  let HH = 30;

  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  const TRANSIT = new Set(["flight", "commute", "airport"]);

  /* A blank starting trip: 7 empty days from today. Replaced when a saved file is opened. */
  function blankTrip() {
    const t = new Date(),
      start = new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())).toISOString().slice(0, 10);
    return {
      app: "trip-planner",
      version: 1,
      title: "My trip",
      start,
      seq: 0,
      places: [
        { id: "home", name: "Home", color: "#cfd3d8" },
        { id: "flight", name: "Flight", color: "#3b8fd4" },
        { id: "commute", name: "Commute", color: "#45474b" },
        { id: "airport", name: "Airport", color: "#5b6b7d" },
        { id: "p1", name: "Destination", color: "#d86d3a" },
      ],
      days: Array.from({ length: 7 }, () => ({ notes: "", blocks: [] })),
    };
  }

  let S = blankTrip();

  const $ = (id) => document.getElementById(id);

  const sel = { d: -1, id: null };

  let dirty = false,
    saveTimer = null;

  /* ===== 2. Formatting helpers ===== */

  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function dateOf(i) {
    const [y, m, d] = S.start.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + i));
  }

  const iso = (dt) => dt.toISOString().slice(0, 10);

  const isoUTC = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

  const addDays = (v, n) => {
    const [y, m, d] = v.split("-").map(Number);
    return isoUTC(y, m - 1, d + n);
  };

  const fmtT = (h) => {
    const hh = Math.floor(h) % 24,
      mm = Math.round((h % 1) * 60);
    return hh + ":" + String(mm).padStart(2, "0");
  };

  const fmt12 = (t) => {
    const h = Math.floor(t + 1e-9) % 24,
      m = Math.round((t - Math.floor(t + 1e-9)) * 60);
    return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
  };

  const fmtD = (v) => {
    const [y, m, d] = v.split("-").map(Number);
    return `${MON[m - 1]} ${d}, ${y}`;
  };

  /* one-line facts for a day: first plan, travel time, free time, where you sleep */
  function dur(h) {
    const m = Math.round(h * 60),
      hh = Math.floor(m / 60),
      mm = m % 60;
    return hh ? (mm ? `${hh}h ${mm}m` : `${hh}h`) : `${mm}m`;
  }

  function ink(hex) {
    const n = parseInt(hex.slice(1), 16),
      r = (n >> 16) & 255,
      g = (n >> 8) & 255,
      b = n & 255;
    return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#15171a" : "#ffffff";
  }

  const place = (id) => S.places.find((p) => p.id === id) || { id, name: "?", color: "#888" };

  /* ===== 3. Trip model: days and blocks ===== */

  function sorted(day) {
    return day.blocks.slice().sort((a, b) => a.s - b.s);
  }

  function nightOf(day) {
    const b = sorted(day);
    return b.length ? b[b.length - 1].p : null;
  }

  function stays(day) {
    const out = [];
    for (const b of sorted(day)) {
      if (TRANSIT.has(b.p)) continue;
      if (!out.includes(b.p)) out.push(b.p);
    }
    return out;
  }

  const isFiller = (b) => /^hotel$/i.test(b.label || "") && !b.desc;

  const shown = (b) => !(/^hotel$/i.test(b.label || "") && !b.desc);

  /* place a block, trimming whatever it covers on that day */
  function apply(day, nb) {
    const out = [];
    for (const b of day.blocks) {
      if (b.id === nb.id) continue;
      if (b.e <= nb.s || b.s >= nb.e) {
        out.push(b);
        continue;
      }
      if (b.s < nb.s) out.push({ ...b, e: nb.s });
      if (b.e > nb.e) out.push({ ...b, s: nb.e, id: b.s < nb.s ? "b" + ++S.seq : b.id });
    }
    out.push(nb);
    day.blocks = out.filter((b) => b.e - b.s > 0.01);
  }

  const snapQ = (h) => Math.round(h * 4) / 4;

  function locate(id) {
    for (let j = 0; j < S.days.length; j++) {
      const b = S.days[j].blocks.find((x) => x.id === id);
      if (b) return { j, d: S.days[j], b };
    }
    return null;
  }

  /* keep: blocks at their final positions; other plain "Hotel" filler is trimmed around them */
  function refill(d, keepIds) {
    const keep = d.blocks.filter((b) => keepIds.has(b.id) || !isFiller(b)),
      taken = keep.map((b) => [b.s, b.e]),
      out = keep.slice();
    for (const h of d.blocks.filter((b) => !keep.includes(b))) {
      let pieces = [[h.s, h.e]];
      for (const [a, z] of taken)
        pieces = pieces.flatMap(([x, y]) =>
          z <= x || a >= y
            ? [[x, y]]
            : [
                [x, Math.min(y, a)],
                [Math.max(x, z), y],
              ].filter(([p, q]) => q - p >= 0.25),
        );
      pieces.forEach(([x, y], k) => out.push({ ...h, s: x, e: y, id: k ? "b" + ++S.seq : h.id }));
    }
    d.blocks = out;
  }

  /* place nb on the day; anything it overlaps is pushed later (and anything that then overlaps, too).
   Plain "Hotel" filler isn't pushed, it just fills whatever time is left. */
  function pushPlan(d, nb) {
    const out = [],
      moved = [];
    let cursor = nb.e;
    for (const b0 of sorted(d).filter((b) => !isFiller(b))) {
      const b = { ...b0 };
      if (b.e <= nb.s + 1e-9) {
        out.push(b);
        continue;
      }
      if (b.s < cursor - 1e-9) {
        const sh = cursor - b.s;
        b.s += sh;
        b.e += sh;
        moved.push(b);
      }
      if (b.s >= nb.e - 1e-9 || moved.includes(b)) cursor = Math.max(cursor, b.e);
      out.push(b);
    }
    const over = moved.filter((b) => b.e > H1 + 1e-9);
    if (over.length) return { ok: false, over };
    out.push({ ...nb });
    // refill plain Hotel time around the result
    const taken = out.map((b) => [b.s, b.e]).sort((a, b) => a[0] - b[0]);
    for (const h of sorted(d).filter(isFiller)) {
      let pieces = [[h.s, h.e]];
      for (const [a, z] of taken) {
        pieces = pieces.flatMap(([x, y]) =>
          z <= x || a >= y
            ? [[x, y]]
            : [
                [x, Math.min(y, a)],
                [Math.max(x, z), y],
              ].filter(([p, q]) => q - p >= 0.25),
        );
      }
      pieces.forEach(([x, y], k) => out.push({ ...h, s: x, e: y, id: k ? "b" + ++S.seq : h.id }));
    }
    return { ok: true, blocks: out, moved };
  }

  function defPlace(i) {
    for (let k = i - 1; k >= 0; k--) {
      const n = nightOf(S.days[k]);
      if (n && !TRANSIT.has(n)) return n;
    }
    const p = S.places.find((x) => !TRANSIT.has(x.id) && x.id !== "home");
    return p ? p.id : "home";
  }

  /* where "+ Add time" puts a new 1-hour row: after the last plan, else in the first free gap, else before the first plan */
  function freeSlot(d) {
    const occ = sorted(d).filter((b) => shown(b) && !/^hotel$/i.test(b.label || ""));
    if (!occ.length) return { s: 9, e: 10 };
    const last = occ[occ.length - 1];
    if (last.e <= H1 - 0.5) return { s: last.e, e: Math.min(H1, last.e + 1), after: last };
    for (let k = 0; k + 1 < occ.length; k++) {
      const a = occ[k].e,
        z = occ[k + 1].s;
      if (z - a >= 0.5) return { s: a, e: Math.min(z, a + 1), after: occ[k] };
    }
    const first = occ[0];
    if (first.s - H0 >= 0.5) return { s: Math.max(H0, first.s - 1), e: first.s };
    return { s: 9, e: 10, full: true, after: last };
  }

  /* the Ends date sets how many days the trip has; extra days are added empty, cut days are removed (Ctrl+Z brings them back) */
  function setEnd(t) {
    const [y, m, d] = S.start.split("-").map(Number),
      [y2, m2, d2] = (t.value || "").split("-").map(Number);
    if (!t.value) {
      renderHeader();
      return;
    }
    const n = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y, m - 1, d)) / 864e5) + 1;
    if (n < 1) {
      setStatus("The end date can't be before the start date", true);
      renderHeader();
      return;
    }
    if (n > 365) {
      setStatus("That's more than a year — pick an earlier end date", true);
      renderHeader();
      return;
    }
    if (n === S.days.length) return;
    const cut = S.days.slice(n).filter((x) => x.blocks.length || x.notes || x.html || x.title).length;
    if (n > S.days.length) while (S.days.length < n) S.days.push({ notes: "", blocks: [] });
    else {
      for (let k = n; k < S.days.length; k++) delete drafts[k];
      S.days.length = n;
      if (sel.d >= n) {
        sel.d = -1;
        sel.id = null;
      }
    }
    changed(true);
    renderAll();
    if (cut) setStatus(`Removed ${cut} day${cut > 1 ? "s" : ""} with plans. Ctrl+Z to undo.`, true);
  }

  /* ===== 4. Rendering ===== */

  function renderAll() {
    renderHeader();
    renderLegend();
    renderDays();
    renderBoard();
  }

  function renderHeader() {
    const n = S.days.length,
      z = dateOf(n - 1);
    if (document.activeElement !== $("ttl")) $("ttl").value = S.title || "";
    $("end").value = iso(z);
    $("start-btn").textContent = fmtD(S.start);
    $("end-btn").textContent = fmtD(iso(z));
    document.title = (S.title || "Trip") + " – Trip Planner";
    $("span").textContent = `${n} day${n === 1 ? "" : "s"}`;
    $("start").value = S.start;
  }

  function renderLegend() {
    const used = new Set(S.days.flatMap((d) => d.blocks.map((b) => b.p)));
    $("legend").innerHTML =
      S.places
        .map(
          (p) =>
            `<span class="chip"><button type="button" class="sw" data-pcb="${p.id}" style="--c:${p.color}" aria-haspopup="dialog" aria-label="Name and color for ${esc(p.name)}"></button><span class="nm">${esc(p.name)}</span></span>`,
        )
        .join("") + `<button type="button" class="chip add-place" data-addplace>+ Add place</button>`;
  }

  function renderDays() {
    const groups = [];
    S.days.forEach((d, i) => {
      const n = nightOf(d),
        k = TRANSIT.has(n) ? "transit" : n;
      const g = groups[groups.length - 1];
      if (g && g.k === k) g.ix.push(i);
      else groups.push({ k, ix: [i] });
    });
    $("days").innerHTML = groups
      .map((g) => {
        const p = g.k === "transit" || !g.k ? null : place(g.k),
          nights = g.ix.length;
        const tt = (a, b) => `<span class="hp">${a}.</span> <span class="hs">${b}.</span>`;
        const head = !g.k
          ? tt("Not planned yet", `${nights} day${nights > 1 ? "s" : ""}`)
          : p
            ? tt(esc(p.name), `${nights} night${nights > 1 ? "s" : ""}`)
            : tt("In transit", `${nights} day${nights > 1 ? "s" : ""}`);
        return `<div class="section"><h2>${head}</h2>${g.ix.map(dayCard).join("")}</div>`;
      })
      .join("");
    growAll();
  }

  function dayCard(i) {
    const d = S.days[i],
      dt = dateOf(i),
      bl = sorted(d),
      st = stays(d);
    const title = st.length
      ? st.map((id) => place(id).name).join(" → ")
      : bl.some((b) => b.p === "flight")
        ? "Travel day"
        : "Free day";
    const bar = bl
      .map(
        (b) =>
          `<span data-mvb="${b.id}" data-mvd="${i}" style="flex:${b.e - b.s};background:${place(b.p).color}" title="${esc(place(b.p).name)} ${fmtT(b.s)}–${fmtT(b.e)}"></span>`,
      )
      .join("");
    const moves = dayFacts(d, bl);
    return `<article class="day${sel.d === i ? " hl" : ""}" id="day-${i}">
    <div class="date"><span class="dow">${DOW[dt.getUTCDay()]}</span><span class="dn">${dt.getUTCDate()}</span><span class="mo">${MON[dt.getUTCMonth()]}</span><span class="ix">Day ${i + 1}</span>${d.done ? `<span class="donetag">✓ Done</span>` : ""}</div>
    <h3><input class="dt" type="text" id="title-${i}" data-title="${i}" value="${esc(d.title || title)}" placeholder="${esc(title)}" aria-label="Title for ${DOW[dt.getUTCDay()]} ${MON[dt.getUTCMonth()]} ${dt.getUTCDate()}"></h3>
    <div><div class="bar">${bar}</div><div class="moves">${moves}</div></div>
    <div style="display:flex;flex-direction:column;gap:6px;min-width:0"><ol class="plan">${bl
      .filter(shown)
      .map((b) => planItem(i, b))
      .join(
        "",
      )}${drafts[i] ? draftItem(i) : ""}</ol><button type="button" class="padd" data-padd="${i}"${drafts[i] ? " hidden" : ""}>+ Add time</button></div>
    <div class="rt"><div class="tb" role="toolbar" aria-label="Text formatting">${TOOLBAR}</div><div class="ed" contenteditable="true" data-notes="${i}" data-ph="Other notes for this day" role="textbox" aria-multiline="true" aria-label="Notes for ${DOW[dt.getUTCDay()]} ${MON[dt.getUTCMonth()]} ${dt.getUTCDate()}">${noteHtml(d)}</div></div>
  </article>`;
  }

  function dayFacts(d, bl) {
    const sum = (f) => bl.filter(f).reduce((a, b) => a + (b.e - b.s), 0);
    const first = bl.find((b) => !/^(hotel|sleep|home)/i.test(b.label || place(b.p).name));
    const travel = sum((b) => TRANSIT.has(b.p)),
      free = sum((b) => /free|rest|nap|pool/i.test(b.label || ""));
    const n = nightOf(d),
      parts = [];
    if (!bl.length)
      return `<span class="empty">Nothing planned yet. Use “+ Add time” or drag on the schedule.</span>`;
    if (first) parts.push(`Starts <b>${fmt12(first.s)}</b>`);
    if (travel > 0) parts.push(`Travel <b>${dur(travel)}</b>`);
    if (free > 0) parts.push(`Free <b>${dur(free)}</b>`);
    parts.push(
      n && !TRANSIT.has(n) ? `Sleep in <b>${esc(place(n).name)}</b>` : `Overnight <b>in the air</b>`,
    );
    return parts.map((x) => `<span class="fct">${x}</span>`).join("");
  }

  function renderDayFacts(i) {
    const el = document.querySelector(`#day-${i} .moves`),
      d = S.days[i];
    if (el && d) el.innerHTML = dayFacts(d, sorted(d));
  }

  function renderBoard() {
    for (const id of [...msel]) if (!locate(id)) msel.delete(id);
    const n = S.days.length,
      hrs = H1 - H0,
      h = hrs * HH;
    const sc = $("sched");
    sc.style.gridTemplateColumns = `52px repeat(${n},minmax(98px,1fr))`;
    sc.style.setProperty("--hh", HH + "px");
    let html = `<div class="corner" style="grid-row:1/4;grid-column:1"></div>`;
    for (let j = 0; j < n; j++) {
      const dt = dateOf(j),
        on = !!S.days[j].done;
      html += `<label class="ckc${on ? " on" : ""}" style="grid-row:1;grid-column:${j + 2}" title="Done with this day"><input type="checkbox" data-done="${j}"${on ? " checked" : ""} aria-label="Done with ${DOW[dt.getUTCDay()]} ${MON[dt.getUTCMonth()]} ${dt.getUTCDate()}"></label>`;
    }
    // week groups, Sunday-start like a calendar
    let i = 0;
    while (i < n) {
      const dw = dateOf(i).getUTCDay();
      const len = Math.min(7 - dw, n - i);
      const a = dateOf(i),
        z = dateOf(i + len - 1);
      html += `<div class="wk" style="grid-row:2;grid-column:${i + 2}/span ${len}">${MON[a.getUTCMonth()]} ${a.getUTCDate()} – ${a.getUTCMonth() === z.getUTCMonth() ? "" : MON[z.getUTCMonth()] + " "}${z.getUTCDate()}</div>`;
      i += len;
    }
    for (let j = 0; j < n; j++) {
      const dt = dateOf(j);
      html += `<button class="dh${sel.d === j ? " colhl" : ""}${S.days[j].done ? " done" : ""}" style="grid-row:3;grid-column:${j + 2}" data-jump="${j}">${DOW[dt.getUTCDay()]} ${dt.getUTCDate()}<small>${MON[dt.getUTCMonth()]}</small></button>`;
    }
    html += `<div class="axis" style="grid-row:4;grid-column:1;height:${h}px;position:sticky">`;
    for (let t = H0 + 1; t < H1; t++) html += `<div style="top:${(t - H0) * HH}px">${fmtT(t)}</div>`;
    html += `</div>`;
    S.days.forEach((d, j) => {
      html += `<div class="col${sel.d === j ? " colhl" : ""}" data-col="${j}" style="grid-row:4;grid-column:${j + 2};height:${h}px">`;
      for (const b of d.blocks) {
        const p = place(b.p),
          top = (b.s - H0) * HH,
          ht = (b.e - b.s) * HH;
        const small = ht < HH * 1.4;
        html += `<button class="blk${small ? " sm" : ""}${isFiller(b) ? " filler" : ""}${sel.id === b.id ? " sel" : ""}${flash === b.id ? " flash" : ""}${msel.has(b.id) ? " msel" : ""}" data-b="${b.id}" data-d="${j}" style="top:${top + 1}px;height:${ht - 2}px;background:${p.color};color:${ink(p.color)}" aria-label="${esc(b.label || p.name)} ${fmtT(b.s)} to ${fmtT(b.e)}"><span class="rz rz-top" aria-hidden="true"></span><span class="n">${esc(b.label || p.name)}</span>${ht >= HH * 1.9 ? `<span class="t">${fmtT(b.s)}–${fmtT(b.e)}</span>` : ""}<span class="rz rz-bot" aria-hidden="true"></span></button>`;
      }
      html += `</div>`;
    });
    sc.innerHTML = html;
  }

  /* ===== 5. Plan rows in the day cards (each row is a schedule block) ===== */

  function topts(from, to, v) {
    let o = "";
    for (let t = from; t <= to + 1e-9; t += 0.25)
      o += `<option value="${t}"${Math.abs(t - v) < 1e-6 ? " selected" : ""}>${fmt12(t)}</option>`;
    return o;
  }

  function planItem(i, b) {
    const p = place(b.p);
    return `<li class="pi${sel.id === b.id ? " pi-hl" : ""}" data-pi="${b.id}" data-pd="${i}" style="--pc:${p.color}">
    <div class="pr">
      <select class="pt" data-ps aria-label="Start time">${topts(H0, H1 - 0.25, b.s)}</select><span class="dash">–</span>
      <select class="pt" data-pe aria-label="End time">${topts(H0 + 0.25, H1, b.e)}</select>
      <input class="pl" data-plab type="text" value="${esc(b.label || "")}" placeholder="${esc(p.name)}" aria-label="Title shown on the schedule">
      <select class="pp" data-pp aria-label="Place (sets the color)" title="Change place">${S.places.map((x) => `<option value="${x.id}"${x.id === b.p ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
      <button type="button" class="px" data-pdel aria-label="Remove this time">×</button>
    </div>
    <div class="pdsv" data-pdv role="button" tabindex="0" aria-label="Edit what you'll do"${hasDesc(b) ? "" : " hidden"}>${descHtml(b)}</div>
    <div class="rt pdrt"${hasDesc(b) ? " hidden" : ""}><div class="tb" role="toolbar" aria-label="Text formatting">${TOOLBAR}</div><div class="ed pded" contenteditable="true" data-pded role="textbox" aria-multiline="true" data-ph="What you'll do" aria-label="What you'll do ${fmt12(b.s)} to ${fmt12(b.e)}">${descHtml(b)}</div></div>
  </li>`;
  }

  /* ---- "What you'll do": rich text, same toolbar as the day notes, plus links ----
     Saved as b.html (cleaned HTML) and b.desc (its plain text). Older files with plain-text
     descriptions still open: bare URLs and [text](url) become links.
     Shown as read-only text with clickable links; clicking the text (not a link) switches to editing. */
  const hasDesc = (b) => !!(b.desc && b.desc.trim());
  const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"]+/g;
  const MD_LINK = /\[([^\]\n]+)\]\(((?:https?:\/\/|www\.)[^\s)]+)\)/g;
  const hrefOf = (u) => (/^www\./i.test(u) ? "https://" + u : u);
  const shortUrl = (u) => {
    const t = u.replace(/^https?:\/\//i, "").replace(/\/$/, "");
    return t.length > 42 ? t.slice(0, 40) + "…" : t;
  };
  const anchor = (u, label) => `<a href="${esc(hrefOf(u))}">${label}</a>`;
  function linkifyBare(t) {
    let out = "",
      last = 0,
      m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(t))) {
      let u = m[0];
      const trail = u.match(/[.,;:!?)\]'"]+$/); // leave sentence punctuation outside the link
      if (trail) u = u.slice(0, -trail[0].length);
      out += esc(t.slice(last, m.index)) + anchor(u, esc(shortUrl(u)));
      last = m.index + u.length;
      URL_RE.lastIndex = last;
    }
    return out + esc(t.slice(last));
  }
  function linkify(text) {
    let out = "",
      last = 0,
      m;
    MD_LINK.lastIndex = 0;
    while ((m = MD_LINK.exec(text))) {
      out += linkifyBare(text.slice(last, m.index)) + anchor(m[2], esc(m[1]));
      last = MD_LINK.lastIndex;
    }
    return out + linkifyBare(text.slice(last));
  }
  function descHtml(b) {
    return clean(b.html != null ? b.html : linkify(b.desc || "").replace(/\n/g, "<br>"));
  }
  function syncDesc(ed) {
    const [, b] = planBlock(ed.closest(".pi"));
    if (!b) return;
    const txt = ed.innerText.trim();
    if (txt) {
      b.html = clean(ed.innerHTML);
      b.desc = txt;
    } else {
      delete b.html;
      delete b.desc;
    }
    dirty = true;
    fileDirty = true;
    setStatus(fileState());
    queueSave(2500);
  }
  function editDesc(view) {
    const rt = view.nextElementSibling,
      ed = rt.querySelector(".ed");
    view.hidden = true;
    rt.hidden = false;
    ed.focus();
    const r = document.createRange();
    r.selectNodeContents(ed);
    r.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  function showDesc(ed) {
    const rt = ed.closest(".pdrt"),
      view = rt && rt.previousElementSibling;
    if (!view || !ed.isConnected || !ed.innerText.trim()) return;
    const [, b] = planBlock(ed.closest(".pi"));
    view.innerHTML = b ? descHtml(b) : clean(ed.innerHTML);
    view.hidden = false;
    rt.hidden = true;
  }
  /* put text into a plain description box (a new row's draft) at the selection, as if typed */
  function insertInto(ta, s, e, text) {
    ta.focus();
    ta.setSelectionRange(s, e);
    if (!document.execCommand("insertText", false, text)) ta.setRangeText(text, s, e, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const isDraftBox = (t) => t && t.tagName === "TEXTAREA" && t.dataset.ddesc != null;
  const isUrl = (t) => /^(https?:\/\/|www\.)\S+$/i.test(t);

  document.addEventListener("click", (ev) => {
    const view = ev.target.closest && ev.target.closest("[data-pdv]");
    if (view && !ev.target.closest("a")) editDesc(view);
  });
  document.addEventListener("keydown", (ev) => {
    const t = ev.target;
    if (t.matches && t.matches("[data-pdv]") && (ev.key === "Enter" || ev.key === " ")) {
      ev.preventDefault();
      editDesc(t);
      return;
    }
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.key.toLowerCase() !== "k") return;
    const ed = t.closest && t.closest(".ed");
    if (ed) {
      ev.preventDefault();
      openEdLink(ed);
    } else if (isDraftBox(t)) {
      ev.preventDefault();
      openPop(t, "link", {
        ta: t,
        s: t.selectionStart,
        e: t.selectionEnd,
        sel: t.value.slice(t.selectionStart, t.selectionEnd),
      });
    }
  });
  /* Rich-text boxes show their toolbar while you're in them. Leaving one hides the toolbar (and turns a
     description back into its read view) only after the mouse button comes up: changing the layout
     mid-click would move whatever you were clicking out from under the pointer. */
  let pointerDown = false;
  document.addEventListener("pointerdown", () => (pointerDown = true), true);
  document.addEventListener("pointerup", () => (pointerDown = false), true);
  document.addEventListener("pointercancel", () => (pointerDown = false), true);
  const afterClick = (fn) => {
    if (!pointerDown) return setTimeout(fn, 0);
    document.addEventListener("pointerup", () => setTimeout(fn, 0), { once: true, capture: true });
  };
  document.addEventListener("focusin", (ev) => {
    const rt = ev.target.closest && ev.target.closest(".rt");
    if (rt) rt.classList.add("editing");
  });
  document.addEventListener("focusout", (ev) => {
    const rt = ev.target.closest && ev.target.closest(".rt");
    if (!rt) return;
    afterClick(() => {
      if (rt.contains(document.activeElement)) return;
      const ed = rt.querySelector(".ed");
      if (pop && pop.kind === "link" && pop.state.ed === ed) return;
      rt.classList.remove("editing");
      if (ed && ed.matches(".pded")) showDesc(ed);
    });
  });
  /* draft rows: select some text, paste a URL over it, and it becomes a named link */
  document.addEventListener("paste", (ev) => {
    const ta = ev.target;
    if (!isDraftBox(ta) || ta.selectionStart === ta.selectionEnd) return;
    const txt = ((ev.clipboardData || window.clipboardData).getData("text/plain") || "").trim();
    if (!isUrl(txt)) return;
    ev.preventDefault();
    const s = ta.selectionStart,
      e = ta.selectionEnd,
      label = ta.value.slice(s, e).replace(/[\[\]]/g, "");
    insertInto(ta, s, e, `[${label}](${txt})`);
  });

  function grow(t) {
    t.style.height = "auto";
    t.style.height = t.scrollHeight + 2 + "px";
  }

  function growAll() {
    document.querySelectorAll(".pdsc").forEach(grow);
  }

  function planBlock(pi) {
    const d = S.days[+pi.dataset.pd];
    return [d, d && d.blocks.find((b) => b.id === pi.dataset.pi)];
  }

  function rerenderPlan(id, attr) {
    renderDays();
    renderBoard();
    renderLegend();
    const el = id && document.querySelector(`.pi[data-pi="${id}"] [${attr}]`);
    if (el) {
      el.focus({ preventScroll: true });
    }
  }

  function planChange(pi, t) {
    const [d, b] = planBlock(pi);
    if (!b) return;
    const attr = t.dataset.ps != null ? "data-ps" : t.dataset.pe != null ? "data-pe" : "data-pp";
    let lost = [];
    if (attr === "data-pp") {
      b.p = t.value;
    } else {
      let s = +pi.querySelector("[data-ps]").value,
        e = +pi.querySelector("[data-pe]").value;
      const len = b.e - b.s;
      // a new start time moves the row and keeps its length; a new end time resizes it
      if (attr === "data-ps") {
        e = Math.min(H1, s + len);
        if (e - s < 0.25) {
          s = Math.max(H0, H1 - len);
          e = H1;
        }
      } else if (e <= s) {
        s = Math.max(H0, e - len);
      }
      if (e <= s) e = Math.min(H1, s + 0.25);
      const before = d.blocks.filter((x) => x.id !== b.id && shown(x));
      apply(d, { ...b, s, e });
      lost = before.filter((x) => !d.blocks.some((y) => y.id === x.id));
    }
    changed(true);
    rerenderPlan(b.id, attr);
    if (lost.length)
      setStatus(
        `Replaced ${lost.map((x) => "“" + (x.label || place(x.p).name) + "”").join(", ")}. Ctrl+Z to undo.`,
        true,
      );
  }

  /* ===== 6. New-row drafts: nothing touches the schedule until Confirm ===== */

  let drafts = {};

  function newDraft(i) {
    const d = S.days[i],
      slot = freeSlot(d),
      lb = slot.after;
    return {
      s: slot.s,
      e: slot.e,
      label: "",
      desc: "",
      p: lb && !TRANSIT.has(lb.p) ? lb.p : stays(d).slice(-1)[0] || defPlace(i),
    };
  }

  function draftNote(i) {
    const dr = drafts[i];
    if (!dr) return { t: "", bad: false };
    const r = pushPlan(S.days[i], { id: "_draft", ...dr });
    if (!r.ok)
      return {
        t: `Not enough room before midnight to move ${r.over.map((b) => "“" + (b.label || place(b.p).name) + "”").join(", ")} — pick another time`,
        bad: true,
      };
    if (!r.moved.length) return { t: "", bad: false };
    return {
      t: "Will move later: " + r.moved.map((b) => `${b.label || place(b.p).name} → ${fmt12(b.s)}`).join(", "),
      bad: false,
    };
  }

  function draftItem(i) {
    const dr = drafts[i],
      p = place(dr.p),
      n = draftNote(i);
    return `<li class="pi draft" data-dd="${i}" style="--pc:${p.color}">
    <div class="pr">
      <select class="pt" data-ds aria-label="Start time">${topts(H0, H1 - 0.25, dr.s)}</select><span class="dash">–</span>
      <select class="pt" data-de aria-label="End time">${topts(H0 + 0.25, H1, dr.e)}</select>
      <input class="pl" data-dl type="text" value="${esc(dr.label)}" placeholder="Title on the schedule" aria-label="Title shown on the schedule">
      <select class="pp" data-dp aria-label="Place (sets the color)" title="Change place">${S.places.map((x) => `<option value="${x.id}"${x.id === dr.p ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
    </div>
    <textarea class="pdsc" data-ddesc rows="1" placeholder="What you'll do" aria-label="What you'll do">${esc(dr.desc)}</textarea>
    <div class="dacts"><span class="dnote${n.bad ? " bad" : ""}" data-dnote>${esc(n.t)}</span><button type="button" data-dcancel>Cancel</button><button type="button" class="primary" data-dconfirm${n.bad ? " disabled" : ""}>Confirm</button></div>
  </li>`;
  }

  function refreshDraftNote(li) {
    const i = +li.dataset.dd,
      n = draftNote(i),
      el = li.querySelector("[data-dnote]");
    el.textContent = n.t;
    el.classList.toggle("bad", n.bad);
    li.querySelector("[data-dconfirm]").disabled = n.bad;
  }

  function confirmDraft(i) {
    const dr = drafts[i],
      d = S.days[i];
    if (!dr || !d) return;
    const nb = {
      id: "b" + ++S.seq,
      p: dr.p,
      s: dr.s,
      e: dr.e,
      label: dr.label.trim() || undefined,
      desc: dr.desc.trim() ? dr.desc : undefined,
    };
    const r = pushPlan(d, nb);
    if (!r.ok) {
      setStatus("Not enough room before midnight — pick another time", true);
      return;
    }
    d.blocks = r.blocks;
    delete drafts[i];
    changed(true);
    renderDays();
    renderBoard();
    renderLegend();
    if (r.moved.length)
      setStatus(
        `Added. Moved ${r.moved.map((b) => "“" + (b.label || place(b.p).name) + "”").join(", ")} later. Ctrl+Z to undo.`,
      );
    focusBlock(i, nb.id, false);
  }

  /* ===== 7. Rich-text notes ===== */

  const TOOLBAR = [
    ["bold", "<b>B</b>", "Bold (Ctrl+B)"],
    ["italic", "<i>I</i>", "Italic (Ctrl+I)"],
    ["underline", "<u>U</u>", "Underline (Ctrl+U)"],
    ["strikeThrough", "<s>S</s>", "Strikethrough"],
    0,
    ["hl", "<span class='hlb'>A</span>", "Highlight"],
    ["red", "<span class='clr'>A</span>", "Red text"],
    0,
    ["insertUnorderedList", "&bull; List", "Bulleted list"],
    ["insertOrderedList", "1. List", "Numbered list"],
    ["outdent", "&#8676;", "Decrease indent"],
    ["indent", "&#8677;", "Increase indent"],
    0,
    ["link", "Link", "Add link (Ctrl+K)"],
    0,
    ["removeFormat", "Clear", "Clear formatting"],
  ]
    .map((b) =>
      b
        ? `<button type="button" data-cmd="${b[0]}" title="${b[2]}" aria-label="${b[2]}">${b[1]}</button>`
        : `<span class="sep" aria-hidden="true"></span>`,
    )
    .join("");

  const OKTAG = new Set([
    "B",
    "STRONG",
    "I",
    "EM",
    "U",
    "S",
    "STRIKE",
    "DEL",
    "MARK",
    "UL",
    "OL",
    "LI",
    "BR",
    "P",
    "DIV",
    "SPAN",
    "BLOCKQUOTE",
    "A",
  ]);

  const OKSTYLE = [
    "font-weight",
    "font-style",
    "text-decoration",
    "text-decoration-line",
    "background-color",
    "color",
  ];

  function cleanNode(n) {
    for (const c of [...n.childNodes]) {
      if (c.nodeType === 3) continue;
      if (c.nodeType !== 1) {
        c.remove();
        continue;
      }
      if (!OKTAG.has(c.tagName)) {
        if (/^(SCRIPT|STYLE|IFRAME|OBJECT)$/.test(c.tagName)) {
          c.remove();
          continue;
        }
        cleanNode(c);
        c.replaceWith(...c.childNodes);
        continue;
      }
      const st = [];
      for (const p of OKSTYLE) {
        const v = c.style.getPropertyValue(p);
        if (v && /^[#\w\s(),.%-]+$/.test(v)) st.push(p + ":" + v);
      }
      const href = c.tagName === "A" ? (c.getAttribute("href") || "").trim() : "";
      if (c.tagName === "A" && !/^https?:\/\//i.test(href)) {
        cleanNode(c);
        c.replaceWith(...c.childNodes); // drop links that aren't web addresses
        continue;
      }
      for (const a of [...c.attributes]) c.removeAttribute(a.name);
      if (st.length) c.setAttribute("style", st.join(";"));
      if (href) {
        c.setAttribute("href", href);
        c.setAttribute("target", "_blank");
        c.setAttribute("rel", "noopener noreferrer");
        c.setAttribute("title", href);
      }
      cleanNode(c);
    }
  }

  function clean(html) {
    const doc = new DOMParser().parseFromString("<div>" + html + "</div>", "text/html");
    const r = doc.body.firstChild;
    if (!r) return "";
    cleanNode(r);
    return r.innerHTML;
  }

  function noteHtml(d) {
    return d.html != null ? clean(d.html) : esc(d.notes || "").replace(/\n/g, "<br>");
  }

  function syncNotes(ed) {
    const d = S.days[+ed.dataset.notes];
    if (!d) return;
    d.html = clean(ed.innerHTML);
    d.notes = ed.innerText.trim();
    dirty = true;
    fileDirty = true;
    setStatus(fileState());
    queueSave(2500);
  }

  /* both kinds of rich-text box: the day's notes and a row's "What you'll do" */
  function syncEd(ed) {
    if (ed.dataset.notes != null) syncNotes(ed);
    else if (ed.dataset.pded != null) syncDesc(ed);
  }

  function runCmd(cmd, btn) {
    const ed = btn.closest(".rt").querySelector(".ed");
    if (cmd === "link") {
      openEdLink(ed);
      return;
    }
    const s = getSelection();
    if (!s.rangeCount || !ed.contains(s.anchorNode)) ed.focus();
    try {
      document.execCommand("styleWithCSS", false, true);
    } catch (e) {}
    if (cmd === "hl") {
      const v = String(document.queryCommandValue("backColor") || "");
      const on = /255,\s*206/.test(v);
      document.execCommand("hiliteColor", false, on ? "transparent" : "rgba(255,206,0,0.42)");
    } else if (cmd === "red") {
      const v = String(document.queryCommandValue("foreColor") || "");
      const on = /207,\s*58,\s*45/.test(v);
      document.execCommand("foreColor", false, on ? getComputedStyle(ed).color : "#cf3a2d");
    } else document.execCommand(cmd, false, null);
    syncEd(ed);
  }

  /* Ctrl+K or the Link button: remember the selection, ask for the address in a popover */
  function openEdLink(ed) {
    const s = getSelection(),
      range = s.rangeCount && ed.contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null;
    openPop(ed, "link", { ed, range, sel: range ? range.toString() : "" });
  }

  document.addEventListener("mousedown", (ev) => {
    if (ev.target.closest(".tb button")) ev.preventDefault();
  });

  document.addEventListener("paste", (ev) => {
    const ed = ev.target.closest && ev.target.closest(".ed");
    if (!ed) return;
    ev.preventDefault();
    const txt = (ev.clipboardData || window.clipboardData).getData("text/plain"),
      url = txt.trim(),
      s = getSelection();
    if (/^(https?:\/\/|www\.)\S+$/i.test(url)) {
      const href = /^www\./i.test(url) ? "https://" + url : url;
      if (s.rangeCount && !s.isCollapsed) document.execCommand("createLink", false, href);
      else
        document.execCommand("insertHTML", false, `<a href="${esc(href)}">${esc(shortUrl(href))}</a>&nbsp;`);
    } else document.execCommand("insertText", false, txt);
    syncEd(ed);
  });

  /* ===== 8. Places: add and rename ===== */

  /* a new place gets the first palette color nobody uses yet */
  function addPlace() {
    const used = new Set(S.places.map((p) => p.color.toLowerCase())),
      color = PALETTE.find((c) => !used.has(c)) || PALETTE[0],
      id = "p" + ++S.seq;
    S.places.push({ id, name: "New place", color });
    return id;
  }

  /* clicking a block selects it (outline on the schedule, its row highlighted); Esc clears it */
  function deselectBlock() {
    if (sel.id == null) return;
    sel.id = null;
    markRow(null);
    renderBoard();
  }

  /* ===== 9. Focus and highlighting between the day cards and the schedule ===== */

  function markDay(i, scroll) {
    sel.d = i;
    document.querySelectorAll(".day.hl").forEach((e) => e.classList.remove("hl"));
    const el = $("day-" + i);
    if (el) {
      el.classList.add("hl");
      if (scroll) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  /* clicking a schedule block: highlight its day and its row in the day card, and bring that row to the
     middle of the page (plain "Hotel" filler has no row, so its day card is centred instead) */
  function markRow(id) {
    document.querySelectorAll(".pi.pi-hl").forEach((e) => e.classList.remove("pi-hl"));
    const row = id && document.querySelector(`.pi[data-pi="${id}"]`);
    if (row) row.classList.add("pi-hl");
    return row;
  }
  function revealRow(i, id) {
    markDay(i, false);
    const row = markRow(id);
    (row || $("day-" + i)).scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" });
  }

  /* drag on an empty part of a column to create a block */
  /* show a day or one block on the schedule: highlight it and slide the board to it */
  let flash = null,
    flashTimer = null;

  function focusDay(i, bringBoard) {
    if (sel.d === i && !flash && !bringBoard) {
      scrollToCol(i, null, false);
      return;
    }
    markDay(i, false);
    flash = null;
    renderBoard();
    scrollToCol(i, null, bringBoard);
  }

  function focusBlock(i, id, bring = true, hold = false) {
    markDay(i, false);
    flash = id;
    renderBoard();
    scrollToCol(i, id, bring);
    clearTimeout(flashTimer);
    if (!hold)
      flashTimer = setTimeout(() => {
        flash = null;
        const el = document.querySelector(".blk.flash");
        if (el) el.classList.remove("flash");
      }, 2600);
  }

  function scrollToCol(i, id, bringBoard) {
    const sc = $("scroller"),
      col = sc && sc.querySelector(`[data-col="${i}"]`);
    if (!col) return;
    const axis = 52,
      left = col.offsetLeft - axis - Math.max(0, (sc.clientWidth - axis - col.offsetWidth) / 2);
    let top = sc.scrollTop;
    if (id) {
      const b = col.querySelector(`[data-b="${id}"]`);
      if (b) top = col.offsetTop + b.offsetTop - (sc.clientHeight - col.offsetTop) / 2;
    }
    sc.scrollTo({ left: Math.max(0, left), top: Math.max(0, top), behavior: "smooth" });
    if (bringBoard && !matchMedia("(min-width:1000px)").matches)
      $("board").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* focusing a plan row points at its block on the schedule */
  document.addEventListener("focusin", (ev) => {
    const pi = ev.target.closest && ev.target.closest(".pi");
    if (!pi || !pi.dataset.pi) return;
    if (flash === pi.dataset.pi) {
      clearTimeout(flashTimer);
      return;
    }
    focusBlock(+pi.dataset.pd, pi.dataset.pi, false, true);
  });

  /* the block stays highlighted until focus leaves its row */
  document.addEventListener("focusout", (ev) => {
    const pi = ev.target.closest && ev.target.closest(".pi");
    if (!pi || !pi.dataset.pi) return;
    const to = ev.relatedTarget;
    if (to && pi.contains(to)) return;
    setTimeout(() => {
      const a = document.activeElement,
        cur = a && a.closest && a.closest(".pi");
      if (cur && cur.dataset.pi === flash) return;
      if (flash === pi.dataset.pi) {
        flash = null;
        document.querySelectorAll(".blk.flash").forEach((e) => e.classList.remove("flash"));
      }
    }, 0);
  });

  /* ===== 10. Schedule: drag on empty space to create a block ===== */

  let drag = null;

  $("sched").addEventListener("pointerdown", (ev) => {
    const col = ev.target.closest(".col");
    if (!col || ev.target.closest(".blk")) return;
    if (msel.size) {
      msel.clear();
      selStatus();
      renderBoard();
      return;
    }
    const r = col.getBoundingClientRect(),
      hAt = (y) => Math.max(H0, Math.min(H1, H0 + Math.round(((y - r.top) / HH) * 2) / 2));
    const s = Math.max(H0, Math.min(H1 - 0.5, H0 + Math.floor(((ev.clientY - r.top) / HH) * 2) / 2));
    const g = document.createElement("div");
    g.className = "ghost";
    col.appendChild(g);
    drag = { col, j: +col.dataset.col, s, e: s + 1, g, hAt };
    upd();
    col.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  function upd() {
    const { g, s, e } = drag;
    const a = Math.min(s, e),
      b = Math.max(s, e);
    g.style.top = (a - H0) * HH + "px";
    g.style.height = (b - a) * HH + "px";
  }

  $("sched").addEventListener("pointermove", (ev) => {
    if (!drag) return;
    let e = drag.hAt(ev.clientY);
    if (e === drag.s) e = drag.s + 0.5;
    drag.e = Math.min(H1, e);
    upd();
  });

  $("sched").addEventListener("pointerup", () => {
    if (!drag) return;
    const { j, g } = drag;
    let a = Math.min(drag.s, drag.e),
      b = Math.max(drag.s, drag.e);
    if (b - a < 0.5) b = a + 1;
    b = Math.min(H1, b);
    g.remove();
    drag = null;
    const d = S.days[j],
      near = sorted(d)
        .filter((x) => x.s < a)
        .pop(),
      p = near && !TRANSIT.has(near.p) ? "commute" : stays(d)[0] || defPlace(j);
    const nb = { id: "b" + ++S.seq, p, s: a, e: b };
    apply(d, nb);
    sel.d = j;
    sel.id = nb.id;
    changed(false);
    renderDays();
    renderBoard();
    revealRow(j, nb.id);
    const lab = document.querySelector(`.pi[data-pi="${nb.id}"] [data-plab]`);
    if (lab) lab.focus({ preventScroll: true });
  });

  $("sched").addEventListener("pointercancel", () => {
    if (drag) {
      drag.g.remove();
      drag = null;
    }
  });

  /* ===== 11. Schedule: resize, move and Shift-select blocks ===== */

  let msel = new Set(),
    bd = null,
    suppressClick = false;

  /* how far a group can move without running into other (non-filler) blocks */
  function moveRange(group) {
    let lo = -Infinity,
      hi = Infinity;
    for (const id of group) {
      const L = locate(id);
      if (!L) continue;
      const { d, b } = L;
      let above = H0,
        below = H1;
      for (const o of d.blocks) {
        if (group.has(o.id) || isFiller(o)) continue;
        if (o.e <= b.s + 1e-9) above = Math.max(above, o.e);
        else if (o.s >= b.e - 1e-9) below = Math.min(below, o.s);
      }
      lo = Math.max(lo, above - b.s);
      hi = Math.min(hi, below - b.e);
    }
    return [lo, hi];
  }

  function commitMove(group, dl) {
    const days = new Set();
    for (const id of group) {
      const L = locate(id);
      if (!L) continue;
      L.b.s += dl;
      L.b.e += dl;
      days.add(L.j);
    }
    for (const j of days) refill(S.days[j], group);
    changed(true);
    renderDays();
    renderBoard();
  }

  /* Dragging one block: put it at start s (keeping its length) and move the other blocks out of the way.
     Blocks it overlaps go above or below it by which side of its middle they're on; then anything above
     is pushed up and anything below pushed down only as far as needed. Lengths never change. Returns the
     new times by block id, or null if something would be pushed past the start or end of the day. */
  function ripple(d, xid, s, dur) {
    const e = s + dur,
      mid = (s + e) / 2,
      above = [],
      below = [];
    for (const o of sorted(d)) {
      if (o.id === xid || isFiller(o)) continue;
      const c = { id: o.id, s: o.s, e: o.e };
      if (o.e <= s + 1e-9) above.push(c);
      else if (o.s >= e - 1e-9) below.push(c);
      else ((o.s + o.e) / 2 < mid ? above : below).push(c);
    }
    let lim = s;
    for (let k = above.length - 1; k >= 0; k--) {
      const a = above[k];
      if (a.e > lim + 1e-9) {
        const sh = a.e - lim;
        a.s -= sh;
        a.e -= sh;
      }
      lim = Math.min(lim, a.s);
    }
    lim = e;
    for (const b of below) {
      if (b.s < lim - 1e-9) {
        const sh = lim - b.s;
        b.s += sh;
        b.e += sh;
      }
      lim = Math.max(lim, b.e);
    }
    if ((above.length && above[0].s < H0 - 1e-9) || (below.length && below[below.length - 1].e > H1 + 1e-9))
      return null;
    const out = new Map();
    for (const c of [...above, ...below]) out.set(c.id, c);
    return out;
  }
  /* the schedule column under the pointer (falls back to the nearest one) */
  function colAt(x) {
    const cols = [...document.querySelectorAll("#sched .col")];
    let best = null,
      dist = Infinity;
    for (const c of cols) {
      const r = c.getBoundingClientRect();
      if (x >= r.left && x < r.right) return c;
      const dd = Math.min(Math.abs(x - r.left), Math.abs(x - r.right));
      if (dd < dist) {
        dist = dd;
        best = c;
      }
    }
    return best;
  }

  function resizeBounds(d, b, edge) {
    const others = d.blocks.filter((o) => o.id !== b.id && !isFiller(o)).sort((x, y) => x.s - y.s);
    if (edge === "bot") {
      const next = others.find((o) => o.s >= b.e - 1e-9);
      return { min: b.s + 0.25, max: next ? next.e - 0.25 : H1, nb: next };
    }
    const prev = others.filter((o) => o.e <= b.s + 1e-9).pop();
    return { min: prev ? prev.s + 0.25 : H0, max: b.e - 0.25, nb: prev };
  }

  function selStatus() {
    if (msel.size)
      setStatus(
        `${msel.size} block${msel.size > 1 ? "s" : ""} selected. Drag or press ↑/↓ to move, Delete to remove, Esc to clear.`,
        false,
        0,
      );
    else setStatus(fileState());
  }

  const placeEl = (el, s, e, ls = s, le = e) => {
    el.style.top = (s - H0) * HH + 1 + "px";
    el.style.height = (e - s) * HH - 2 + "px";
    const t = el.querySelector(".t");
    if (t) t.textContent = fmtT(ls) + "–" + fmtT(le);
  };

  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Apple's rubber-band: past a limit the block follows less and less instead of hard-stopping */
  const rubber = (o, dim) => (o * dim * 0.55) / (dim + 0.55 * Math.abs(o));

  const soft = (raw, lo, hi) => {
    const dim = HH * 2;
    if (raw < lo) return lo - rubber((lo - raw) * HH, dim) / HH;
    if (raw > hi) return hi + rubber((raw - hi) * HH, dim) / HH;
    return raw;
  };

  /* critically damped spring (damping 1.0, response 0.3s) from the on-screen offset, starting at the pointer's release velocity */
  function settle(items, v0) {
    if (!items.length) return;
    const done = () =>
      items.forEach((it) => {
        it.el.style.transform = "";
        it.el.style.height = it.h + "px";
      });
    if (reduceMotion()) {
      done();
      return;
    }
    const w = (2 * Math.PI) / 0.3,
      t0 = performance.now(),
      v = Math.max(-3000, Math.min(3000, v0 || 0));
    const at = (x0, vx, t) => (x0 + (vx + w * x0) * t) * Math.exp(-w * t);
    (function f(now) {
      const t = (now - t0) / 1000;
      let live = false;
      for (const it of items) {
        const dy = at(it.dy, it.vy ? v : 0, t),
          dh = at(it.dh, it.vh ? it.vh * v : 0, t);
        it.el.style.transform = `translateY(${dy}px)`;
        it.el.style.height = it.h + dh + "px";
        if (Math.abs(dy) > 0.3 || Math.abs(dh) > 0.3) live = true;
      }
      if (live && t < 1.2) requestAnimationFrame(f);
      else done();
    })(t0);
  }

  $("sched").addEventListener("pointerdown", (ev) => {
    const el = ev.target.closest(".blk");
    if (!el || ev.button !== 0 || ev.shiftKey) return;
    const L = locate(el.dataset.b);
    if (!L) return;
    let mode = ev.target.closest(".rz-top") ? "top" : ev.target.closest(".rz-bot") ? "bot" : "move";
    const group = mode === "move" ? (msel.has(L.b.id) ? new Set(msel) : new Set([L.b.id])) : null;
    // a single block moves freely (other blocks make way, even on another day); a Shift-selected group only moves into free time
    if (mode === "move" && group.size === 1) mode = "free";
    const colTop = el.parentElement.getBoundingClientRect().top;
    bd = {
      mode,
      el,
      L,
      y0: ev.clientY,
      x0: ev.clientX,
      active: false,
      s: L.b.s,
      e: L.b.e,
      dl: 0,
      group,
      range: group ? moveRange(group) : null,
      bounds: mode === "move" || mode === "free" ? null : resizeBounds(L.d, L.b, mode),
      grab: H0 + (ev.clientY - colTop) / HH - L.b.s, // where in the block it was grabbed, in hours
      dur: L.b.e - L.b.s,
      j: L.j,
      t: L.b.s,
      layout: null,
      els: group
        ? [...group]
            .map((id) => {
              const x = document.querySelector(`.blk[data-b="${id}"]`),
                Lx = locate(id);
              return x && Lx ? { x, s: Lx.b.s, e: Lx.b.e } : null;
            })
            .filter(Boolean)
        : null,
    };
    bd.pid = ev.pointerId;
  });

  $("sched").addEventListener("pointermove", (ev) => {
    if (!bd) return;
    const dy = ev.clientY - bd.y0;
    const now = performance.now();
    (bd.hist || (bd.hist = [])).push({ t: now, y: ev.clientY });
    while (bd.hist.length > 2 && now - bd.hist[0].t > 100) bd.hist.shift();
    if (!bd.active) {
      if (Math.hypot(dy, ev.clientX - bd.x0) < 5) return;
      bd.active = true;
      try {
        $("sched").setPointerCapture(bd.pid);
      } catch (e) {}
      (bd.els ? bd.els.map((o) => o.x) : [bd.el]).forEach((x) => x.classList.add("dragging"));
    }
    const dh = dy / HH;
    if (bd.mode === "free") {
      freeMove(ev);
      return;
    }
    if (bd.mode === "move") {
      const [lo, hi] = bd.range,
        vis = soft(dh, lo, hi);
      bd.dl = Math.max(lo, Math.min(hi, snapQ(dh)));
      bd.els.forEach((o) => placeEl(o.x, o.s + vis, o.e + vis, o.s + bd.dl, o.e + bd.dl));
    } else if (bd.mode === "bot") {
      const raw = bd.L.b.e + dh,
        { min, max } = bd.bounds;
      bd.e = Math.max(min, Math.min(max, snapQ(raw)));
      placeEl(bd.el, bd.L.b.s, soft(raw, min, max), bd.L.b.s, bd.e);
    } else {
      const raw = bd.L.b.s + dh,
        { min, max } = bd.bounds;
      bd.s = Math.max(min, Math.min(max, snapQ(raw)));
      placeEl(bd.el, soft(raw, min, max), bd.L.b.e, bd.s, bd.L.b.e);
    }
  });

  function freeMove(ev) {
    const B = bd,
      sc = $("scroller"),
      sr = sc.getBoundingClientRect();
    // nudge the schedule sideways when dragging near its left or right edge
    if (ev.clientX > sr.right - 40) sc.scrollLeft += 14;
    else if (ev.clientX < sr.left + 92) sc.scrollLeft -= 14;
    const col = colAt(ev.clientX);
    if (!col) return;
    const j = +col.dataset.col,
      d = S.days[j];
    if (B.el.parentElement !== col) {
      // moved to another day: put the block in that column and let the old day's blocks go back
      resetPreview(B);
      col.appendChild(B.el);
      B.j = j;
      B.layout = null;
    }
    $("sched").classList.add("free-drag");
    document.querySelectorAll("#sched .col.free-target").forEach((c) => c.classList.remove("free-target"));
    col.classList.add("free-target");
    const top = col.getBoundingClientRect().top,
      raw = H0 + (ev.clientY - top) / HH - B.grab,
      t = Math.max(H0, Math.min(H1 - B.dur, snapQ(raw)));
    const lay = ripple(d, B.L.b.id, t, B.dur);
    if (lay) {
      B.t = t;
      B.layout = lay;
      // slide the others (a transform, so they move as one piece instead of being re-laid out)
      for (const [id, c] of lay) {
        const x = col.querySelector(`.blk[data-b="${id}"]`),
          o = d.blocks.find((q) => q.id === id);
        if (!x || !o) continue;
        x.style.transform = `translateY(${(c.s - o.s) * HH}px)`;
        const tl = x.querySelector(".t");
        if (tl) tl.textContent = fmtT(c.s) + "–" + fmtT(c.e);
      }
    }
    placeEl(B.el, soft(raw, H0, H1 - B.dur), soft(raw, H0, H1 - B.dur) + B.dur, B.t, B.t + B.dur);
  }
  /* put the blocks of the day being previewed back where they are in the trip */
  function resetPreview(B) {
    const d = S.days[B.j],
      col = document.querySelector(`#sched .col[data-col="${B.j}"]`);
    if (!d || !col) return;
    for (const o of d.blocks) {
      const x = col.querySelector(`.blk[data-b="${o.id}"]`);
      if (!x || o.id === B.L.b.id) continue;
      x.style.transform = "";
      const tl = x.querySelector(".t");
      if (tl) tl.textContent = fmtT(o.s) + "–" + fmtT(o.e);
    }
  }
  function commitFree(B) {
    const src = B.L.d,
      dst = S.days[B.j],
      b = B.L.b;
    if (B.j === B.L.j && Math.abs(B.t - b.s) < 1e-9) return false;
    if (!B.layout) B.layout = ripple(dst, b.id, B.t, B.dur);
    if (!B.layout) return false;
    for (const [id, c] of B.layout) {
      const o = dst.blocks.find((x) => x.id === id);
      if (o) {
        o.s = c.s;
        o.e = c.e;
      }
    }
    src.blocks = src.blocks.filter((x) => x.id !== b.id);
    b.s = B.t;
    b.e = B.t + B.dur;
    dst.blocks.push(b);
    refill(dst, new Set([b.id]));
    if (sel.id === b.id) sel.d = B.j;
    changed(true);
    renderDays();
    renderBoard();
    return true;
  }

  function endBlockDrag(commit) {
    if (!bd) return;
    const B = bd;
    bd = null;
    if (!B.active) return;
    suppressClick = true;
    setTimeout(() => {
      suppressClick = false;
    }, 0);
    // where each dragged block is on screen right now, so the settle starts from there
    const from = new Map(
      (B.els ? B.els.map((o) => o.x) : [B.el]).map((x) => [
        x.dataset.b,
        { top: parseFloat(x.style.top), h: parseFloat(x.style.height) },
      ]),
    );
    const h = B.hist || [],
      v = h.length > 1 ? ((h[h.length - 1].y - h[0].y) / Math.max(1, h[h.length - 1].t - h[0].t)) * 1000 : 0;
    if (!commit) {
      renderBoard();
      return;
    }
    document.querySelectorAll("#sched .col.free-target").forEach((c) => c.classList.remove("free-target"));
    $("sched").classList.remove("free-drag");
    if (B.mode === "free") {
      if (!commitFree(B)) renderBoard();
      if (sel.id === B.L.b.id) markRow(sel.id);
    } else if (B.mode === "move") {
      if (Math.abs(B.dl) < 1e-9) renderBoard();
      else {
        commitMove(B.group, B.dl);
        if (msel.size) selStatus();
      }
    } else {
      const { d, b } = B.L,
        nb = B.bounds.nb;
      if (B.mode === "bot") {
        if (nb && B.e > nb.s) nb.s = B.e;
        b.e = B.e;
      } else {
        if (nb && B.s < nb.e) nb.e = B.s;
        b.s = B.s;
      }
      refill(d, new Set([b.id]));
      changed(true);
      renderDays();
      renderBoard();
    }
    const items = [];
    for (const [id, f] of from) {
      const x = document.querySelector(`.blk[data-b="${id}"]`);
      if (!x) continue;
      const top = parseFloat(x.style.top),
        hh = parseFloat(x.style.height);
      items.push({
        el: x,
        h: hh,
        dy: f.top - top,
        dh: f.h - hh,
        vy: B.mode !== "bot",
        vh: B.mode === "bot" ? 1 : B.mode === "top" ? -1 : 0,
      });
      x.style.transform = `translateY(${f.top - top}px)`;
      x.style.height = f.h + "px";
    }
    settle(items, v);
  }

  $("sched").addEventListener("pointerup", () => endBlockDrag(true));

  $("sched").addEventListener("pointercancel", () => endBlockDrag(false));

  document.addEventListener(
    "click",
    (ev) => {
      if (suppressClick && ev.target.closest && ev.target.closest("#sched")) {
        ev.stopPropagation();
        ev.preventDefault();
        suppressClick = false;
      }
    },
    true,
  );

  document.addEventListener("keydown", (ev) => {
    if (!msel.size) return;
    const a = document.activeElement;
    if (a && (isText(a) || a.tagName === "SELECT")) return;
    if (ev.key === "Escape") {
      msel.clear();
      renderBoard();
      selStatus();
      return;
    }
    if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
      ev.preventDefault();
      const dl = ev.key === "ArrowUp" ? -0.25 : 0.25,
        [lo, hi] = moveRange(msel);
      if (dl < lo - 1e-9 || dl > hi + 1e-9) {
        setStatus(
          "No free time to move " + (dl < 0 ? "up" : "down") + " — something else is in the way",
          true,
        );
        return;
      }
      commitMove(msel, dl);
      selStatus();
    }
  });

  /* Delete (or Backspace) removes the selected blocks, or the block open in the editor */
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Delete" && ev.key !== "Backspace") return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const a = document.activeElement;
    if (a && (isText(a) || a.tagName === "SELECT")) return;
    if (pop || !$("ask").hidden) return;
    const ids = msel.size ? [...msel] : sel.id ? [sel.id] : [];
    if (!ids.length) return;
    ev.preventDefault();
    const names = [];
    for (const id of ids) {
      const L = locate(id);
      if (!L) continue;
      names.push("“" + (L.b.label || place(L.b.p).name) + "”");
      L.d.blocks = L.d.blocks.filter((x) => x.id !== id);
    }
    msel.clear();
    if (sel.id && ids.includes(sel.id)) sel.id = null;
    changed(true);
    renderDays();
    renderBoard();
    setStatus(`Deleted ${names.join(", ")}. Ctrl+Z to undo.`);
  });

  /* ===== 12. Popovers: dropdown lists, date picker and color picker ===== */

  let pop = null;

  function openPop(anchor, kind, state) {
    if (pop) closePop(false);
    pop = { anchor, kind, state };
    anchor.setAttribute("aria-expanded", "true");
    const p = $("pop");
    p.hidden = false;
    p.className = "pop " + kind;
    renderPop();
  }

  function closePop(refocus = true) {
    if (!pop) return;
    // a place name typed but not yet applied (closed with Esc or a click elsewhere) still counts
    const nameField = pop.kind === "color" && $("pop").querySelector("[data-pname]");
    if (nameField) renameCommit(nameField);
    const a = pop.anchor;
    a.removeAttribute("aria-expanded");
    pop = null;
    $("pop").hidden = true;
    if (refocus && a && a.isConnected) a.focus();
    else if (a && a.matches && a.matches(".pded"))
      setTimeout(() => document.activeElement !== a && showDesc(a), 0);
  }

  function placePop() {
    const p = $("pop");
    if (!pop || p.hidden) return;
    const r = pop.anchor.getBoundingClientRect(),
      w = p.offsetWidth,
      h = p.offsetHeight;
    let x = Math.min(r.left, innerWidth - w - 12),
      y = r.bottom + 8,
      up = false;
    if (y + h > innerHeight - 12 && r.top - h - 8 > 12) {
      y = r.top - h - 8;
      up = true;
    }
    p.style.left = Math.max(12, x) + "px";
    p.style.top = y + "px";
    p.style.transformOrigin = `${Math.round(r.left + r.width / 2 - Math.max(12, x))}px ${up ? "100%" : "0"}`;
  }

  function renderPop() {
    const p = $("pop");
    if (!pop) return;
    p.innerHTML =
      pop.kind === "cal"
        ? calHTML()
        : pop.kind === "list"
          ? listHTML()
          : pop.kind === "link"
            ? linkHTML()
            : colorHTML();
    if (pop.kind === "list")
      p.style.minWidth = Math.max(120, Math.round(pop.anchor.getBoundingClientRect().width)) + "px";
    else p.style.minWidth = "";
    placePop();
    const f =
      p.querySelector(
        pop.kind === "cal"
          ? ".cd.cur"
          : pop.kind === "list"
            ? ".lo.on"
            : pop.kind === "link"
              ? "[data-lku]"
              : ".cs.on",
      ) || p.querySelector(".cd:not([disabled]),.cs,.lo");
    if (f) {
      f.focus({ preventScroll: true });
      if (pop.kind === "list")
        p.scrollTop = Math.max(0, f.offsetTop - p.clientHeight / 2 + f.offsetHeight / 2);
    }
  }

  /* Ctrl+K in a description: add a link at the cursor, or around the selected text */
  function linkHTML() {
    const st = pop.state;
    return `<div class="lk-t">Add link</div>
      <input type="url" class="lk-in" data-lku placeholder="Paste a link (https://…)" aria-label="Link address">
      ${st.sel ? `<p class="lk-sel">Links “${esc(st.sel.length > 40 ? st.sel.slice(0, 38) + "…" : st.sel)}”</p>` : `<input type="text" class="lk-in" data-lkx placeholder="Text to show (optional)" aria-label="Text to show">`}
      <div class="lk-a"><button type="button" data-lkc>Cancel</button><button type="button" class="primary" data-lka>Add link</button></div>`;
  }
  function applyLink() {
    const st = pop.state,
      p = $("pop");
    let url = (p.querySelector("[data-lku]").value || "").trim();
    if (!url) {
      p.querySelector("[data-lku]").focus();
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = "https://" + url.replace(/^\/+/, "");
    const x = p.querySelector("[data-lkx]"),
      label = (st.sel || (x && x.value) || "").replace(/[\[\]]/g, "").trim();
    closePop(false);
    if (st.ta) {
      insertInto(st.ta, st.s, st.e, label ? `[${label}](${url})` : url);
      return;
    }
    const ed = st.ed,
      s = getSelection();
    ed.focus();
    if (st.range) {
      s.removeAllRanges();
      s.addRange(st.range);
    }
    if (st.sel) document.execCommand("createLink", false, url);
    else
      document.execCommand(
        "insertHTML",
        false,
        `<a href="${esc(url)}">${esc(label || shortUrl(url))}</a>&nbsp;`,
      );
    syncEd(ed);
  }

  /* dropdown lists (times, places): the select keeps the value, this menu replaces the browser's */
  function listHTML() {
    const st = pop.state;
    return st.items
      .map(
        (it) =>
          `<button type="button" class="lo${it.v === st.cur ? " on" : ""}" data-lv="${esc(it.v)}" role="option" aria-selected="${it.v === st.cur}">${it.color ? `<span class="dot" style="--c:${it.color}"></span>` : ""}<span>${esc(it.label)}</span></button>`,
      )
      .join("");
  }

  function openList(sel) {
    const placeSel = sel.matches("[data-pp],[data-dp]");
    const items = [...sel.options].map((o) => ({
      v: o.value,
      label: o.textContent,
      color: placeSel ? (S.places.find((p) => p.id === o.value) || {}).color : null,
    }));
    if (placeSel) items.push({ v: "__new", label: "New place…", color: null });
    openPop(sel, "list", { sel, items, cur: sel.value });
  }

  function pickList(v) {
    const sel = pop.state.sel;
    closePop(false);
    if (v === "__new") {
      // make the place, put this row (or draft) in it, then open its popover so it can be named
      const id = addPlace(),
        pi = sel.closest(".pi"),
        find = pi.classList.contains("draft")
          ? () => document.querySelector(`.pi.draft[data-dd="${pi.dataset.dd}"] [data-dp]`)
          : () => document.querySelector(`.pi[data-pi="${pi.dataset.pi}"] [data-pp]`);
      const o = document.createElement("option");
      o.value = id;
      o.textContent = place(id).name;
      sel.appendChild(o);
      sel.value = id;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      renderLegend();
      openPlace(find(), id, true, find);
      return;
    }
    if (sel.value === v) {
      sel.focus();
      return;
    }
    sel.value = v;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }

  document.addEventListener(
    "mousedown",
    (ev) => {
      const sel = ev.target.closest && ev.target.closest("select");
      if (!sel || ev.button !== 0) return;
      ev.preventDefault();
      if (pop && pop.anchor === sel) {
        closePop();
        return;
      }
      sel.focus({ preventScroll: true });
      openList(sel);
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (ev) => {
      const sel = ev.target;
      if (!sel || sel.tagName !== "SELECT") return;
      if (
        ev.key === "Enter" ||
        ev.key === " " ||
        ev.key === "F4" ||
        (ev.altKey && (ev.key === "ArrowDown" || ev.key === "ArrowUp"))
      ) {
        ev.preventDefault();
        openList(sel);
      }
    },
    true,
  );

  function calHTML() {
    const st = pop.state,
      [vy, vm] = [st.y, st.m],
      first = new Date(Date.UTC(vy, vm, 1)),
      lead = first.getUTCDay(),
      days = new Date(Date.UTC(vy, vm + 1, 0)).getUTCDate();
    const start = S.start,
      end = addDays(S.start, S.days.length - 1),
      t = new Date(),
      today = isoUTC(t.getFullYear(), t.getMonth(), t.getDate());
    let cells = "";
    for (let k = 0; k < 42; k++) {
      const v = isoUTC(vy, vm, 1 - lead + k),
        [, mm, dd] = v.split("-").map(Number),
        out = mm - 1 !== ((vm % 12) + 12) % 12;
      const dis = st.which === "end" && (v < start || v > addDays(start, 364));
      const cls = [
        "cd",
        out ? "out" : "",
        v === st.cur ? "cur" : "",
        v >= start && v <= end ? "in" : "",
        v === start ? "rs" : "",
        v === end ? "re" : "",
        v === today ? "today" : "",
        (st.which === "start" ? v === start : v === end) ? "on" : "",
      ]
        .filter(Boolean)
        .join(" ");
      cells += `<button type="button" class="${cls}" data-cd="${v}" tabindex="${v === st.cur ? 0 : -1}"${dis ? " disabled" : ""} aria-label="${MON[mm - 1]} ${dd}${dis ? ", unavailable" : ""}">${dd}</button>`;
    }
    return `<div class="cal-h"><button type="button" class="nav" data-cnav="-1" aria-label="Previous month">‹</button><div class="cal-t" aria-live="polite">${MONTHS[((vm % 12) + 12) % 12]} ${new Date(Date.UTC(vy, vm, 1)).getUTCFullYear()}</div><button type="button" class="nav" data-cnav="1" aria-label="Next month">›</button></div>
    <div class="cal-w" aria-hidden="true">${["S", "M", "T", "W", "T", "F", "S"].map((x) => `<span>${x}</span>`).join("")}</div>
    <div class="cal-g">${cells}</div>
    <p class="cal-f">${st.which === "start" ? "Moving the start shifts the whole trip." : "Pick the last day of the trip."}</p>`;
  }

  function openCal(btn) {
    const which = btn.dataset.cal,
      cur = which === "start" ? S.start : addDays(S.start, S.days.length - 1),
      [y, m] = cur.split("-").map(Number);
    openPop(btn, "cal", { which, cur, y, m: m - 1 });
  }

  function pickDate(v) {
    const which = pop.state.which,
      inp = $(which);
    inp.value = v;
    closePop();
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const PALETTE = [
    "#ff453a",
    "#ff9f0a",
    "#ffd60a",
    "#30d158",
    "#63e6e2",
    "#40c8e0",
    "#64d2ff",
    "#0a84ff",
    "#5e5ce6",
    "#bf5af2",
    "#ff375f",
    "#ac8e68",
    "#b2384a",
    "#d86d3a",
    "#1e8c86",
    "#0f5f7a",
    "#8d3a9c",
    "#3b8fd4",
    "#f5f5f7",
    "#c7c7cc",
    "#8e8e93",
    "#636366",
    "#48484a",
    "#2c2c2e",
  ];

  function colorHTML() {
    const cur = (pop.state.cur || "").toLowerCase();
    return `<input type="text" class="cp-name" data-pname value="${esc(place(pop.state.placeId).name)}" aria-label="Place name (renames it everywhere)" placeholder="Place name"><div class="cp-g">${PALETTE.map((c) => `<button type="button" class="cs${c === cur ? " on" : ""}" data-cs="${c}" style="--c:${c}" aria-label="${c}"></button>`).join("")}</div>
    <div class="cp-f"><span class="cp-now" style="--c:${cur || "#888"}"></span><span class="cp-hex">${cur.toUpperCase()}</span><label class="cp-more">More colors<input type="color" data-cmore value="${cur || "#888888"}"></label></div>`;
  }

  /* a place's popover: rename it (everywhere) and pick its color. Opened from its legend dot, or from a
     row right after "New place…". reanchor() finds the control again after the page re-renders. */
  function openPlace(anchor, placeId, focusName, reanchor) {
    if (!anchor) return;
    reanchor = reanchor || (() => document.querySelector(`[data-pcb="${placeId}"]`));
    openPop(anchor, "color", { placeId, cur: place(placeId).color, reanchor, focusName });
    if (focusName) {
      const n = $("pop").querySelector("[data-pname]");
      n.focus();
      n.select();
    }
  }
  function openColor(btn) {
    openPlace(btn, btn.dataset.pcb, false);
  }
  function placeChanged() {
    changed(true);
    renderLegend();
    renderDays();
    renderBoard();
    const a = pop && pop.state.reanchor();
    if (a) pop.anchor = a;
  }

  function pickColor(c, keepOpen) {
    const st = pop.state;
    st.cur = c;
    place(st.placeId).color = c;
    placeChanged();
    if (keepOpen) renderPop();
    else closePop();
  }

  /* typing a name updates the legend as you type; leaving the field (or Enter) applies it everywhere */
  function renameLive(input) {
    const p = place(pop.state.placeId),
      chip = document.querySelector(`[data-pcb="${p.id}"]`);
    if (chip) chip.nextElementSibling.textContent = input.value || p.name;
  }
  function renameCommit(input) {
    if (!pop || pop.kind !== "color") return;
    const p = place(pop.state.placeId),
      v = input.value.trim();
    if (!v || v === p.name) {
      input.value = p.name;
      renameLive(input);
      return;
    }
    p.name = v;
    placeChanged();
  }

  $("pop").addEventListener("click", (ev) => {
    const t = ev.target.closest("button");
    if (!t || !pop) return;
    ev.stopPropagation();
    if (t.dataset.cnav) {
      pop.state.m += +t.dataset.cnav;
      const d = new Date(Date.UTC(pop.state.y, pop.state.m, 1));
      pop.state.y = d.getUTCFullYear();
      pop.state.m = d.getUTCMonth();
      pop.state.cur = isoUTC(pop.state.y, pop.state.m, Math.min(+pop.state.cur.slice(8), 28));
      renderPop();
      const n = $("pop").querySelector(`[data-cnav="${t.dataset.cnav}"]`);
      if (n) n.focus();
      return;
    }
    if (t.dataset.cd && !t.disabled) {
      pickDate(t.dataset.cd);
      return;
    }
    if (t.dataset.lv != null) {
      pickList(t.dataset.lv);
      return;
    }
    if (t.dataset.lka != null) {
      applyLink();
      return;
    }
    if (t.dataset.lkc != null) {
      closePop();
      return;
    }
    if (t.dataset.cs) {
      pickColor(t.dataset.cs, false);
    }
  });

  $("pop").addEventListener("input", (ev) => {
    if (!pop) return;
    if (ev.target.dataset.cmore != null) pickColor(ev.target.value.toLowerCase(), true);
    else if (ev.target.dataset.pname != null) renameLive(ev.target);
  });
  $("pop").addEventListener("change", (ev) => {
    if (ev.target.dataset.pname != null) renameCommit(ev.target);
  });

  $("pop").addEventListener("keydown", (ev) => {
    if (!pop) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      closePop();
      return;
    }
    if (ev.target.dataset && ev.target.dataset.pname != null) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        renameCommit(ev.target);
        const g = $("pop").querySelector(".cs.on") || $("pop").querySelector(".cs");
        if (g) g.focus();
      }
      return;
    }
    if (pop.kind === "link") {
      if (ev.key === "Enter" && ev.target.tagName === "INPUT") {
        ev.preventDefault();
        applyLink();
      }
      return;
    }
    if (pop.kind === "cal") {
      const st = pop.state,
        mv = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[ev.key];
      if (mv != null || ev.key === "PageUp" || ev.key === "PageDown") {
        ev.preventDefault();
        if (mv != null) st.cur = addDays(st.cur, mv);
        else {
          const [y, m, d] = st.cur.split("-").map(Number);
          st.cur = isoUTC(y, m - 1 + (ev.key === "PageUp" ? -1 : 1), Math.min(d, 28));
        }
        const [y, m] = st.cur.split("-").map(Number);
        st.y = y;
        st.m = m - 1;
        renderPop();
      }
    } else if (pop.kind === "list") {
      const all = [...$("pop").querySelectorAll(".lo")],
        i = all.indexOf(document.activeElement);
      const mv = { ArrowUp: -1, ArrowDown: 1, PageUp: -8, PageDown: 8 }[ev.key];
      if (mv != null || ev.key === "Home" || ev.key === "End") {
        ev.preventDefault();
        const n =
          all[
            ev.key === "Home"
              ? 0
              : ev.key === "End"
                ? all.length - 1
                : Math.max(0, Math.min(all.length - 1, i + mv))
          ];
        if (n) {
          n.focus({ preventScroll: true });
          const p = $("pop");
          if (n.offsetTop < p.scrollTop) p.scrollTop = n.offsetTop - 6;
          else if (n.offsetTop + n.offsetHeight > p.scrollTop + p.clientHeight)
            p.scrollTop = n.offsetTop + n.offsetHeight - p.clientHeight + 6;
        }
      } else if (ev.key === "Tab") {
        ev.preventDefault();
        closePop();
      }
    } else {
      const all = [...$("pop").querySelectorAll(".cs")],
        i = all.indexOf(document.activeElement),
        mv = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -9, ArrowDown: 9 }[ev.key];
      if (mv != null && i >= 0) {
        ev.preventDefault();
        const n = all[Math.max(0, Math.min(all.length - 1, i + mv))];
        n.focus();
      }
    }
  });

  document.addEventListener(
    "pointerdown",
    (ev) => {
      if (pop && !ev.target.closest("#pop") && !pop.anchor.contains(ev.target)) closePop(false);
    },
    true,
  );

  window.addEventListener("resize", () => placePop());

  window.addEventListener("scroll", () => placePop(), { passive: true });

  document.addEventListener("click", (ev) => {
    const b = ev.target.closest && ev.target.closest("[data-cal],[data-pcb]");
    if (!b) return;
    ev.preventDefault();
    if (pop && pop.anchor === b) {
      closePop();
      return;
    }
    if (b.dataset.cal) openCal(b);
    else openColor(b);
  });

  /* ===== 13. Undo and redo (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y) ===== */

  let past = [],
    future = [],
    last = null;

  const focusVal = new WeakMap();

  function resetHistory() {
    past = [];
    future = [];
    last = JSON.stringify(S);
  }

  function snap() {
    if (last == null) {
      last = JSON.stringify(S);
      return;
    }
    const cur = JSON.stringify(S);
    if (cur !== last) {
      past.push(last);
      if (past.length > 150) past.shift();
      last = cur;
      future = [];
    }
  }

  function restore(json, msg) {
    drafts = {};
    msel.clear();
    S = JSON.parse(json);
    last = json;
    sel.id = null;
    flash = null;
    renderAll();
    dirty = true;
    fileDirty = true;
    setStatus(msg);
    queueSave(1200);
  }

  function undo() {
    snap();
    if (!past.length) {
      setStatus("Nothing to undo");
      return;
    }
    future.push(last);
    restore(past.pop(), "Undone. Ctrl+Shift+Z to redo.");
  }

  function redo() {
    if (!future.length) {
      setStatus("Nothing to redo");
      return;
    }
    past.push(last);
    restore(future.pop(), "Redone");
  }

  const isText = (a) =>
    a && (a.isContentEditable || a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && a.type === "text"));

  const valOf = (a) => (a.isContentEditable ? a.innerHTML : a.value);

  document.addEventListener("focusin", (ev) => {
    const a = ev.target;
    if (isText(a)) focusVal.set(a, valOf(a));
  });

  document.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
    const k = ev.key.toLowerCase();
    if (k !== "z" && k !== "y") return;
    const a = document.activeElement;
    // inside a text box you've typed in, let the browser undo the typing first
    if (isText(a) && focusVal.get(a) !== valOf(a)) return;
    ev.preventDefault();
    if (document.activeElement && document.activeElement.blur && isText(a)) a.blur();
    k === "y" || ev.shiftKey ? redo() : undo();
  });

  /* ===== 14. Saving and files ===== */

  const DRAFT = "trip-planner-draft";

  let fileName = null,
    fileHandle = null,
    fileDirty = false,
    dl = null;

  /* Status line. A message (anything other than the file state) stays up for a few seconds before the
     file state comes back, so autosave doesn't wipe it straight away. Pass hold 0 to keep it until replaced. */
  let msgHold = 0,
    msgTimer = null;
  function setStatus(t, bad, hold) {
    const s = $("status");
    s.textContent = t;
    s.classList.toggle("bad", !!bad);
    clearTimeout(msgTimer);
    if (hold === undefined) hold = t === fileState() ? 0 : bad ? 6000 : 4000;
    msgHold = hold ? Date.now() + hold : 0;
    if (hold)
      msgTimer = setTimeout(() => {
        msgHold = 0;
        if (msel.size) selStatus();
        else setStatus(fileState());
      }, hold);
  }

  function fileState() {
    return fileDirty
      ? fileName
        ? `Unsaved changes in ${fileName}`
        : "Not saved to a file yet"
      : fileName
        ? `Saved to ${fileName}`
        : "New trip";
  }

  function changed(save) {
    snap();
    dirty = true;
    fileDirty = true;
    setStatus(fileState());
    queueSave(save ? 600 : 1500);
  }

  function queueSave(ms) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, ms);
  }

  function save() {
    if (!dirty) return;
    try {
      localStorage.setItem(DRAFT, JSON.stringify({ S, fileName, fileDirty }));
    } catch (e) {}
    dirty = false;
    if (Date.now() >= msgHold && !msel.size) setStatus(fileState());
  }

  window.addEventListener("beforeunload", () => {
    if (dirty) save();
  });

  const slug = (t) =>
    (String(t || "trip")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "trip") + ".json";

  function tripJSON() {
    return JSON.stringify(
      { ...S, app: "trip-planner", version: 1, savedAt: new Date().toISOString() },
      null,
      2,
    );
  }

  const canFS = () => {
    try {
      return window.self === window.top && "showSaveFilePicker" in window;
    } catch (e) {
      return false;
    }
  };

  async function saveFile(asNew) {
    const json = tripJSON(),
      name = (!asNew && fileName) || slug(S.title);
    try {
      if (canFS()) {
        if (asNew || !fileHandle)
          fileHandle = await window.showSaveFilePicker({
            suggestedName: name,
            types: [{ description: "Trip file", accept: { "application/json": [".json"] } }],
          });
        const w = await fileHandle.createWritable();
        await w.write(json);
        await w.close();
        fileName = fileHandle.name;
      } else if (dl) {
        await dl.save({ filename: name, data: json });
        fileName = name;
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(a.href);
          a.remove();
        }, 1000);
        fileName = name;
      }
      fileDirty = false;
      dirty = true;
      save();
      setStatus(`Saved to ${fileName}`);
      return true;
    } catch (e) {
      if (e && (e.name === "AbortError" || e.code === "declined")) {
        setStatus(fileState());
        return false;
      }
      setStatus("Couldn't save the file: " + ((e && e.message) || "unknown error"), true);
      return false;
    }
  }

  /* accept files from this app: needs a days array; fill in anything missing */
  function normalize(j) {
    if (!j || !Array.isArray(j.days)) throw new Error("this isn't a trip file (no days found).");
    const base = blankTrip();
    const T = {
      title: typeof j.title === "string" ? j.title : base.title,
      start: /^\d{4}-\d{2}-\d{2}$/.test(j.start || "") ? j.start : base.start,
      places:
        Array.isArray(j.places) && j.places.length
          ? j.places
              .filter((p) => p && p.id)
              .map((p) => ({
                id: String(p.id),
                name: String(p.name || p.id),
                color: /^#[0-9a-f]{6}$/i.test(p.color || "") ? p.color : "#888888",
              }))
          : base.places,
      days: j.days.map((d) => ({
        done: d && d.done ? true : undefined,
        title: d && typeof d.title === "string" ? d.title : undefined,
        notes: d && typeof d.notes === "string" ? d.notes : "",
        html: d && typeof d.html === "string" ? d.html : undefined,
        blocks: (d && Array.isArray(d.blocks) ? d.blocks : [])
          .filter((b) => b && isFinite(b.s) && isFinite(b.e) && +b.e > +b.s)
          .map((b) => ({
            id: String(b.id || ""),
            p: String(b.p || "home"),
            s: Math.max(H0, +b.s),
            e: Math.min(H1, +b.e),
            label: b.label ? String(b.label) : undefined,
            desc: b.desc ? String(b.desc) : undefined,
            html: typeof b.html === "string" ? b.html : undefined,
          })),
      })),
      seq: 0,
    };
    for (const t of ["home", "flight", "commute", "airport"])
      if (!T.places.some((p) => p.id === t)) T.places.push(base.places.find((p) => p.id === t));
    let n = +j.seq || 0;
    const seen = new Set();
    for (const d of T.days)
      for (const b of d.blocks) {
        const m = /^b(\d+)$/.exec(b.id);
        if (m) n = Math.max(n, +m[1]);
      }
    for (const p of T.places) {
      const m = /^p(\d+)$/.exec(p.id);
      if (m) n = Math.max(n, +m[1]);
    }
    for (const d of T.days)
      for (const b of d.blocks) {
        if (!b.id || seen.has(b.id)) b.id = "b" + ++n;
        seen.add(b.id);
      }
    T.seq = n;
    return T;
  }

  function loadTrip(T, name, handle) {
    drafts = {};
    msel.clear();
    S = T;
    fileName = name || null;
    fileHandle = handle || null;
    fileDirty = false;
    sel.id = null;
    sel.d = -1;
    flash = null;
    renderAll();
    resetHistory();
    dirty = true;
    save();
    setStatus(name ? `Opened ${name}` : "New trip");
    requestAnimationFrame(() => {
      measureHead();
      window.scrollTo({ top: 0 });
    });
  }

  async function openFile() {
    if (canFS() && "showOpenFilePicker" in window) {
      try {
        const [h] = await window.showOpenFilePicker({
          types: [{ description: "Trip file", accept: { "application/json": [".json"] } }],
        });
        const f = await h.getFile();
        readTrip(f, h);
      } catch (e) {
        if (e && e.name !== "AbortError") setStatus("Couldn't open the file: " + e.message, true);
      }
      return;
    }
    $("f-input").value = "";
    $("f-input").click();
  }

  async function readTrip(f, handle) {
    try {
      const T = normalize(JSON.parse(await f.text()));
      loadTrip(T, f.name, handle);
    } catch (e) {
      setStatus(
        "Couldn't open " +
          ((f && f.name) || "that file") +
          ": " +
          (e instanceof SyntaxError ? "it isn't valid JSON." : e.message),
        true,
      );
    }
  }

  $("f-input").addEventListener("change", (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (f) readTrip(f, null);
  });

  /* New and Open: with unsaved changes, ask first (Save or Discard), then carry on */
  let asking = null; // { next: "new" | "open", opener }
  const startNew = () => loadTrip(blankTrip(), null, null);

  function guarded(next, opener) {
    if (!fileDirty) {
      next === "new" ? startNew() : openFile();
      return;
    }
    asking = { next, opener };
    showAsk(
      "Discard changes?",
      `You have unsaved changes${fileName ? ` in ${fileName}` : ""}. Save them first, or discard them and ` +
        (next === "new" ? "start a new trip." : "open another trip."),
      [
        ["discard", "Discard", "dlg-discard"],
        ["save", "Save", "dlg-save"],
      ],
    );
  }

  function showAsk(title, text, buttons) {
    $("ask-t").textContent = title;
    $("ask-d").textContent = text;
    $("ask").querySelector(".dlg-acts").innerHTML = buttons
      .map(([k, label, cls]) => `<button type="button" class="${cls}" data-ask="${k}">${label}</button>`)
      .join("");
    $("ask").hidden = false;
    const last = $("ask").querySelectorAll("[data-ask]");
    last[last.length - 1].focus();
  }

  function hideAsk(refocus) {
    $("ask").hidden = true;
    if (refocus && asking && asking.opener) asking.opener.focus();
    asking = null;
  }

  async function answerAsk(choice) {
    const a = asking;
    if (!a) return;
    if (choice === "pick") {
      // second step after saving: a fresh click is needed before the browser will show a file picker
      hideAsk(false);
      openFile();
      return;
    }
    if (choice === "discard") {
      hideAsk(false);
      a.next === "new" ? startNew() : openFile();
      return;
    }
    // Save first; if the save is cancelled or fails, nothing else happens and the changes stay
    $("ask").hidden = true;
    const ok = await saveFile(false);
    if (!ok) {
      asking = null;
      return;
    }
    if (a.next === "new") {
      asking = null;
      startNew();
      return;
    }
    const active = !navigator.userActivation || navigator.userActivation.isActive;
    if (active) {
      asking = null;
      openFile();
    } else {
      asking = a;
      showAsk("Saved", `Your changes are saved to ${fileName}. Now choose the trip to open.`, [
        ["cancel", "Cancel", "dlg-plain"],
        ["pick", "Choose file", "dlg-save"],
      ]);
    }
  }

  $("ask").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-ask]");
    if (b) {
      b.dataset.ask === "cancel" ? hideAsk(true) : answerAsk(b.dataset.ask);
      return;
    }
    if (ev.target === $("ask")) hideAsk(true); // click outside the dialog cancels
  });

  $("ask").addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      hideAsk(true);
    } else if (ev.key === "Tab") {
      // keep focus inside the dialog
      const bs = [...$("ask").querySelectorAll("[data-ask]")],
        i = bs.indexOf(document.activeElement);
      ev.preventDefault();
      bs[(i + (ev.shiftKey ? bs.length - 1 : 1)) % bs.length].focus();
    }
  });

  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("button");
    if (!t) return;
    if (t.id === "f-save") {
      saveFile(false);
    } else if (t.id === "f-saveas") {
      saveFile(true);
    } else if (t.id === "f-open") {
      guarded("open", t);
    } else if (t.id === "f-new") {
      guarded("new", t);
    }
  });

  document.addEventListener("change", (ev) => {
    if (ev.target.id === "ttl") {
      S.title = ev.target.value.trim() || "My trip";
      changed(true);
      renderHeader();
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
    const k = ev.key.toLowerCase();
    if (k === "s") {
      ev.preventDefault();
      saveFile(ev.shiftKey);
    } else if (k === "o") {
      ev.preventDefault();
      $("f-open").click();
    }
  });

  /* ===== 15. Page-wide event handlers ===== */

  document.addEventListener("click", (ev) => {
    const mv = ev.target.closest("[data-mvb]");
    if (mv) {
      focusBlock(+mv.dataset.mvd, mv.dataset.mvb);
      return;
    }
    const card = ev.target.closest(".day");
    if (card && !ev.target.closest("button") && !ev.target.closest(".pi")) {
      focusDay(+card.id.slice(4), false);
    }
    const t = ev.target.closest("button,[data-jump]");
    if (!t) return;
    if (t.dataset.cmd) {
      runCmd(t.dataset.cmd, t);
      return;
    }
    if (t.dataset.pdel != null) {
      const pi = t.closest(".pi"),
        [d, b] = planBlock(pi);
      if (b) {
        d.blocks = d.blocks.filter((x) => x !== b);
        if (sel.id === b.id) sel.id = null;
        changed(true);
        rerenderPlan();
      }
      return;
    }
    if (t.dataset.padd != null) {
      const i = +t.dataset.padd;
      if (!drafts[i]) drafts[i] = newDraft(i);
      renderDays();
      focusDay(i, false);
      const el = document.querySelector(`.pi.draft[data-dd="${i}"] [data-dl]`);
      if (el) el.focus();
      return;
    }
    if (t.dataset.dconfirm != null) {
      confirmDraft(+t.closest(".pi").dataset.dd);
      return;
    }
    if (t.dataset.dcancel != null) {
      delete drafts[+t.closest(".pi").dataset.dd];
      renderDays();
      return;
    }
    if (t.dataset.b && ev.shiftKey) {
      const id = t.dataset.b;
      if (msel.has(id)) msel.delete(id);
      else msel.add(id);
      if (sel.id) {
        sel.id = null;
        markRow(null);
      }
      renderBoard();
      selStatus();
      return;
    }
    if (t.dataset.b && msel.size) {
      msel.clear();
      selStatus();
    }
    if (t.dataset.b) {
      sel.d = +t.dataset.d;
      sel.id = t.dataset.b;
      renderBoard();
      revealRow(sel.d, sel.id);
      return;
    }
    if (t.dataset.jump != null) {
      markDay(+t.dataset.jump, true);
      return;
    }
    if (t.dataset.addplace != null) {
      const id = addPlace();
      changed(true);
      renderLegend();
      renderDays();
      openPlace(document.querySelector(`[data-pcb="${id}"]`), id, true);
      return;
    }
  });

  document.addEventListener("change", (ev) => {
    const t = ev.target;
    const pi = t.closest && t.closest(".pi");
    if (pi && pi.classList.contains("draft")) {
      const i = +pi.dataset.dd,
        dr = drafts[i];
      if (!dr) return;
      if (t.dataset.dp != null) {
        dr.p = t.value;
        pi.style.setProperty("--pc", place(dr.p).color);
        return;
      }
      if (t.dataset.ds != null || t.dataset.de != null) {
        let s = +pi.querySelector("[data-ds]").value,
          e = +pi.querySelector("[data-de]").value;
        const len = dr.e - dr.s;
        if (t.dataset.ds != null) {
          e = Math.min(H1, s + len);
          if (e - s < 0.25) {
            s = Math.max(H0, H1 - len);
            e = H1;
          }
        } else if (e <= s) {
          s = Math.max(H0, e - len);
        }
        if (e <= s) e = Math.min(H1, s + 0.25);
        dr.s = s;
        dr.e = e;
        pi.querySelector("[data-ds]").value = s;
        pi.querySelector("[data-de]").value = e;
        refreshDraftNote(pi);
      }
      return;
    }
    if (pi && (t.dataset.ps != null || t.dataset.pe != null || t.dataset.pp != null)) {
      planChange(pi, t);
      return;
    }
    if (pi && t.dataset.plab != null) {
      snap();
      renderDayFacts(+pi.dataset.pd);
      return;
    }
    if (t.id === "start" && t.value) {
      S.start = t.value;
      changed(true);
      renderAll();
      return;
    }
    if (t.id === "end") {
      setEnd(t);
      return;
    }
    if (t.dataset.done != null) {
      const d = S.days[+t.dataset.done];
      if (!d) return;
      if (t.checked) d.done = true;
      else delete d.done;
      changed(true);
      renderDays();
      renderBoard();
      return;
    }
    if (t.dataset.title != null) {
      const d = S.days[+t.dataset.title],
        v = t.value.trim();
      if (!v || v === t.placeholder) {
        delete d.title;
        t.value = t.placeholder;
      } else d.title = v;
      changed(true);
      return;
    }
  });

  document.addEventListener("input", (ev) => {
    const t = ev.target;
    if (t.dataset && t.dataset.notes != null) {
      syncNotes(t);
    }
    if (t.dataset && (t.dataset.dl != null || t.dataset.ddesc != null)) {
      const dr = drafts[+t.closest(".pi").dataset.dd];
      if (!dr) return;
      if (t.dataset.dl != null) dr.label = t.value;
      else {
        dr.desc = t.value;
        grow(t);
      }
      return;
    }
    if (t.dataset && t.dataset.pded != null) {
      syncDesc(t);
      return;
    }
    if (t.dataset && t.dataset.plab != null) {
      const [d, b] = planBlock(t.closest(".pi"));
      if (!b) return;
      b.label = t.value.trim() || undefined;
      renderBoard();
      dirty = true;
      fileDirty = true;
      setStatus(fileState());
      queueSave(2500);
      return;
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && sel.id && !msel.size) deselectBlock();
    const dli = ev.target.closest && ev.target.closest(".pi.draft");
    if (!dli) return;
    const i = +dli.dataset.dd;
    if (ev.key === "Escape") {
      delete drafts[i];
      renderDays();
      const b = document.querySelector(`[data-padd="${i}"]`);
      if (b) b.focus();
    } else if (ev.key === "Enter" && ev.target.dataset.dl != null) {
      ev.preventDefault();
      if (!dli.querySelector("[data-dconfirm]").disabled) confirmDraft(i);
    }
  });

  document.addEventListener("focusout", (ev) => {
    const t = ev.target;
    if (t.dataset && (t.dataset.notes != null || (t.closest && t.closest(".pi")))) {
      snap();
      if (dirty) queueSave(400);
    }
  });

  window.addEventListener("resize", () => growAll());

  /* Header: full size at the top of the page, one slim bar once you scroll. While slim, the space it
     gave up is kept as margin underneath (out of sight above the page), so nothing below it jumps. */
  let condensed = false;
  function setCondensed(on) {
    const h = $("sh");
    if (!h || on === condensed) return;
    // the browser's scroll anchoring would otherwise "correct" the scroll position mid-swap
    const root = document.documentElement;
    root.style.overflowAnchor = "none";
    const before = h.offsetHeight;
    h.classList.toggle("condensed", on);
    condensed = on;
    h.style.marginBottom = on ? `${before - h.offsetHeight - 14}px` : "";
    measureHead();
    requestAnimationFrame(() => (root.style.overflowAnchor = ""));
  }
  window.addEventListener(
    "scroll",
    () => {
      const h = $("sh"),
        y = scrollY;
      if (h) h.classList.toggle("scrolled", y > 2);
      // the legend fades out as it slides up under the header
      $("legend").style.opacity = Math.max(0, 1 - y / 70).toFixed(2);
      fitBoardToLegend();
      if (!condensed && y > 60) setCondensed(true);
      else if (condensed && y < 8) setCondensed(false);
    },
    { passive: true },
  );
  window.addEventListener("resize", () => {
    // re-measure the slim bar's compensation for the new width
    if (condensed) {
      setCondensed(false);
      setCondensed(scrollY > 8);
    }
  });

  /* ===== 16. Boot ===== */

  function fitHours() {
    const sc = $("scroller");
    if (!sc) return;
    let nh = 30;
    if (matchMedia("(min-width:1000px)").matches) {
      const top = sc.querySelector(".dh"),
        hd = top ? top.offsetTop + top.offsetHeight : 74;
      nh = Math.max(24, Math.floor((sc.clientHeight - hd - 2) / (H1 - H0)));
    }
    if (nh !== HH) {
      HH = nh;
      renderBoard();
    }
  }

  function measureHead() {
    const h = $("sh");
    if (h) document.documentElement.style.setProperty("--headh", h.offsetHeight + "px");
    fitBoardToLegend();
    requestAnimationFrame(fitHours);
  }
  /* near the top the legend sits above the schedule, so shorten the schedule by that much to keep its
     bottom on screen; once the legend has scrolled away this is 0 */
  function fitBoardToLegend() {
    const h = $("sh"),
      bd = $("board");
    if (!h || !bd) return;
    const v = matchMedia("(min-width:1000px)").matches
      ? Math.max(0, Math.round(bd.getBoundingClientRect().top - h.getBoundingClientRect().bottom - 2))
      : 0;
    document.documentElement.style.setProperty("--legvis", v + "px");
  }

  try {
    const ro = new ResizeObserver(measureHead);
    ro.observe($("sh"));
    ro.observe($("scroller"));
  } catch (e) {
    window.addEventListener("resize", measureHead);
  }

  async function boot() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT) || "null");
      if (d && d.S) {
        S = normalize(d.S);
        fileName = d.fileName || null;
        fileDirty = !!d.fileDirty;
      }
    } catch (e) {}
    renderAll();
    resetHistory();
    measureHead();
    setStatus(fileState());
    try {
      dl = window.claude && window.claude.use ? await window.claude.use("downloads") : null;
    } catch (e) {
      dl = null;
    }
  }

  boot();
})();
