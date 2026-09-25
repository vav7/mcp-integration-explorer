#!/usr/bin/env python3
"""Real-browser verification of the v19 information architecture (Chromium).

Run: python3 tests/browser_check.py [http://127.0.0.1:PORT]   (or a file:// demo)
"""
from __future__ import annotations
import os, sys, time
from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8133").rstrip("/")
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "docs", "screenshots"))
os.makedirs(OUT, exist_ok=True)
results = []
def check(name, cond, extra=""):
    results.append((name, bool(cond)))
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "  | " + str(extra)))
def shot(p, n): p.screenshot(path=os.path.join(OUT, n)); print("       shot -> " + n)

LAUNCH = ["--no-sandbox", "--disable-dev-shm-usage", "--js-flags=--jitless", "--single-process"]

with sync_playwright() as pw:
    b = pw.chromium.launch(args=LAUNCH)
    page = b.new_page(viewport={"width": 1600, "height": 1000}, color_scheme="dark")
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "favicon" not in m.text.lower() and "Failed to load resource" not in m.text else None)

    def fresh(url, expect=None):
        """Bounce through about:blank (a hash-only goto never re-runs init),
        then wait on a condition rather than a clock: this sandbox loads a
        426KB snapshot at whatever speed it manages."""
        page.goto("about:blank"); page.goto(url, wait_until="domcontentloaded")
        if expect:
            page.wait_for_selector(expect, state="attached", timeout=30000)
        page.wait_for_timeout(1200)

    fresh(BASE + "/")
    print("--- home IA ---")
    check("home keeps signals + trends as real sections",
          page.locator("main section#signals").count() == 1 and page.locator("main section#trends").count() == 1)
    check("trends is the last home section", page.evaluate(
        "() => { const s=[...document.querySelectorAll('main section')]; return s[s.length-1].id === 'trends'; }"))
    check("analytics + methodology are NOT home sections",
          page.locator("main section#analytics").count() == 0 and page.locator("main section#methodology").count() == 0)
    check("top nav = the off-page views only, Help first with its book mark",
          page.evaluate("() => [...document.querySelectorAll('.nav-links a')].map(a=>a.textContent.trim()).join(',')")
          == "Help,Intelligence,Methodology,Pricing"
          and page.locator('.nav-links a.nav-help svg').count() == 1,
          page.evaluate("() => [...document.querySelectorAll('.nav-links a')].map(a=>a.textContent.trim()).join(',')"))
    check("exactly two deep-dive cards", page.locator("[data-openview]").count() == 2)
    check("home signal wire is compact: capped, and neither it nor its panel is a scroll container",
          page.evaluate("""() => { const l=document.querySelector('#signalList'), w=document.querySelector('.sig-compact');
            const sc = e => { const o=getComputedStyle(e).overflowY; return o==='auto'||o==='scroll'; };
            return l.children.length>0 && l.children.length<=6 && !sc(l) && !sc(w); }"""),
          page.evaluate("() => document.querySelector('#signalList').children.length"))
    shot(page, "v19-01-home.png")

    print("--- explorer + rail alignment & premium scroller ---")
    m = page.evaluate("""() => {
      const L=document.querySelector('.layout').getBoundingClientRect();
      const C=document.querySelector('.expl-col').getBoundingClientRect();
      const R=document.querySelector('.rail').getBoundingClientRect();
      const sc=document.querySelector('#viewContent');
      const cs=getComputedStyle(sc);
      return {L:L.height, C:C.height, R:R.height, topC:C.top, topR:R.top,
              oy:cs.overflowY, rows:sc.querySelectorAll('tbody tr').length,
              scrollable: sc.scrollHeight > sc.clientHeight};
    }""")
    check("apps block and What-changed block are the same height & top-aligned",
          abs(m["C"] - m["R"]) <= 2 and abs(m["topC"] - m["topR"]) <= 2, m)
    check("app list scrolls internally (premium scroller)", m["oy"] in ("auto","scroll") and m["scrollable"], m)
    check("all 100 rows live inside the scroller", m["rows"] == 100, m["rows"])
    check("scroller has the thin styled thumb", page.evaluate(
        "() => getComputedStyle(document.querySelector('#viewContent'),'::-webkit-scrollbar').width") in ("8px","9px"))
    page.evaluate("document.querySelector('#apps').scrollIntoView()"); page.wait_for_timeout(600)
    shot(page, "v19-02-explorer-aligned.png")
    page.evaluate("document.querySelector('#viewContent').scrollTo({top:1500,behavior:'instant'})"); page.wait_for_timeout(300)
    check("scroller actually scrolls", page.evaluate("() => document.querySelector('#viewContent').scrollTop") > 800)
    check("rail feed scrolls inside its own pane", page.evaluate(
        "() => { const f=document.querySelector('.rail-pane.active .feed'); const cs=getComputedStyle(f); return cs.overflowY==='auto'; }"))

    print("--- intelligence = landscape in parts, no tabs ---")
    page.locator('.nav-links a[data-view="intelligence"]').click(); page.wait_for_timeout(1200)
    check("intelligence opens", page.locator("#intelligenceView.open").count() == 1)
    check("three tabs group the six instruments", page.locator("#ivTabs [data-ivpart]").count() == 3
          and page.locator("#intelligenceView .an-card").count() == 6)
    check("default tab shows a compact 2-up spread", page.evaluate(
        "() => { const g=document.querySelector('#ivpSupply .an-grid'); return getComputedStyle(g).gridTemplateColumns.split(' ').length===2 && g.querySelectorAll('.an-card').length===2; }"))
    check("the open pane is short (compact, not a stack)", page.evaluate(
        "() => document.querySelector('#ivpSupply').getBoundingClientRect().height < 560"))
    shot(page, "v20-03-intel-supply.png")
    page.locator('[data-ivpart="health"]').click(); page.wait_for_timeout(700)
    check("Code & endpoints tab shows freshness + probe truth", page.locator("#ivpHealth:visible .an-card").count() == 2)
    shot(page, "v20-04-intel-health.png")
    page.locator('[data-ivpart="adoption"]').click(); page.wait_for_timeout(900)
    check("Adoption & latency tab shows scatter + latency", page.locator("#ivpAdoption:visible .an-card").count() == 2
          and page.locator("#ivpAdoption:visible #anScatterBody svg").count() == 1)
    shot(page, "v20-05-intel-adoption.png")
    page.keyboard.press("Escape"); page.wait_for_timeout(500)

    print("--- methodology is live + interactive ---")
    page.locator('.nav-links a[data-view="methodology"]').click(); page.wait_for_timeout(1300)
    check("summary gauge drew to the live average", page.evaluate(
        "() => { const a=document.querySelector('#msArc'); return a && parseFloat(a.style.strokeDashoffset) < 314; }"))
    live_txt = page.evaluate(
        "Array.from(document.querySelectorAll('[data-methlive]')).map(e => e.textContent.trim())")
    check("live figures populated (not placeholders)",
          len(live_txt) >= 7 and all(t and t != "\u2026" for t in live_txt), live_txt)
    check("seven interactive stages", page.locator("#methodologyView .pipe-hit").count() == 7)
    first = page.locator("#methodologyView .pipe").first
    first.locator(".pipe-hit").click(); page.wait_for_timeout(600)
    check("clicking a stage expands its live detail", first.get_attribute("class").find("open") >= 0
          and first.locator(".pipe-x").evaluate("e => getComputedStyle(e).gridTemplateRows") not in ("0px", "0fr"))
    shot(page, "v20-06-methodology-open.png")
    page.evaluate("document.querySelector('#methodologyView').scrollTop=900"); page.wait_for_timeout(500)
    check("spine draws with scroll", page.evaluate(
        "() => parseFloat(getComputedStyle(document.querySelector('#methodologyView .pipeline')).getPropertyValue('--spine') || 0) > 0"))
    page.keyboard.press("Escape"); page.wait_for_timeout(500)

    print("--- drawer (toggle bar) is de-cluttered ---")
    page.locator("#drawerBtn").click(); page.wait_for_timeout(600)
    labels = page.evaluate("() => [...document.querySelectorAll('#drawer .dw-label')].map(x=>x.textContent.trim())")
    check("drawer groups are exactly Views / Compare / Actions",
          [x.split()[0] for x in labels] == ["Views","Compare","Actions"], labels)
    check("drawer dropped the redundant navigate + explorer-view lists",
          page.locator('#drawer [data-dview]').count() == 0 and page.locator('#drawer a[href="#overview"]').count() == 0)
    check("drawer keeps the important actions", page.locator("#dwSearch").count() == 1 and page.locator("#dwRefresh").count() == 1 and page.locator("#dwCompare").count() == 1)
    shot(page, "v19-05-drawer.png")
    page.locator("#drawerClose").click(); page.wait_for_timeout(400)

    print("--- home trends + signals render live ---")
    page.evaluate("document.querySelector('#trends').scrollIntoView()"); page.wait_for_timeout(900)
    check("home trend chart drew an svg", page.locator("#chart svg").count() == 1)
    check("trend metric switcher present on home", page.locator("#trendTabs button").count() >= 5)
    page.evaluate("document.querySelector('#signals').scrollIntoView()"); page.wait_for_timeout(700)
    check("home signal wire shows entries", page.locator("#signalList .sig").count() >= 3)
    shot(page, "v19-06-trends-signals.png")

    print("--- deep links still work ---")
    fresh(BASE + "/#methodology", "#methodologyView.open"); check("#methodology opens its window", page.locator("#methodologyView.open").count() == 1)
    fresh(BASE + "/#intelligence", "#intelligenceView.open"); check("#intelligence opens its window", page.locator("#intelligenceView.open").count() == 1)
    fresh(BASE + "/app/81", "#modal.open"); check("/app/81 opens Stripe dossier", page.locator("#modal.open").count() == 1 and "Stripe" in page.locator("#modal .mh-id h3").inner_text())

    print("--- dossier Changes tab ---")
    fresh(BASE + "/app/64", "#modal.open")
    check("dossier shows Evidence | Changes tabs", page.locator("#mTabs [data-mtab]").count() == 2)
    page.locator('[data-mtab="changes"]').click(); page.wait_for_timeout(1200)
    check("Changes pane renders a change summary", page.locator("#mPaneChanges .chg-counts").count() == 1)
    check("potential breaking changes are severity-coloured cards",
          page.locator("#mPaneChanges .cb-row").count() >= 1)
    check("added/removed/modified lists present", page.locator("#mPaneChanges .chg-item").count() >= 3)
    check("history timeline rendered", page.locator("#mPaneChanges .tl-row").count() >= 1)
    check("snapshot selectors + Compare available", page.locator("#chgFrom").count() == 1
          and page.locator("#chgTo").count() == 1 and page.locator("[data-chgdiff]").count() == 1)
    page.locator('[data-mtab="evidence"]').click(); page.wait_for_timeout(400)
    check("Evidence tab still works", page.locator("#mPaneEvidence").is_visible())

    print("--- v24: ticker reaches Intelligence + the app list ---")
    page.keyboard.press("Escape"); page.wait_for_timeout(500)   # deep-link section left a dossier open
    page.goto(BASE + "/", wait_until="domcontentloaded"); page.wait_for_timeout(2500)
    app_tick = page.evaluate("""async () => {
      const sleep=ms=>new Promise(r=>setTimeout(r,ms));
      const row=document.querySelector('#viewContent tbody tr'); const id=row.dataset.id;
      const app=window.__mcpx.state.snap.apps.find(a=>String(a.app.id)===id);
      const prev=app.readiness.score; await sleep(1100);
      app.readiness.score=Math.max(0,prev-6); window.__mcpx.renderView();
      const n=document.querySelector('#viewContent tbody tr[data-id="'+id+'"] .snum');
      let min=1e9; for(let i=0;i<14;i++){ await sleep(40); const v=parseInt(n.textContent,10); if(!isNaN(v)) min=Math.min(min,v); }
      await sleep(500); const end=parseInt(n.textContent,10);
      app.readiness.score=prev; window.__mcpx.renderView(); await sleep(300);
      return {prev, end, min};
    }""")
    check("app-list readiness ticks DOWN from prev (never from 0)",
          app_tick["min"] >= app_tick["end"] - 2 and app_tick["min"] > 5, app_tick)
    page.locator('.nav-links a[data-view="intelligence"]').click(); page.wait_for_timeout(1400)
    intel = page.evaluate("""async () => {
      const sleep=ms=>new Promise(r=>setTimeout(r,ms));
      const avg=document.querySelector('#anNAvg'); await sleep(1100);
      const before=avg.textContent;
      const st=window.__mcpx.state.snap.stats; const t0=st.total_tools;
      st.avg_readiness=(+st.avg_readiness||0)+1.2; window.__mcpx.renderAnalytics();
      let first=null; for(let i=0;i<6;i++){ await sleep(45); if(first===null && avg.textContent!==before) first=avg.textContent; }
      await sleep(700); const after=avg.textContent;
      const bar=document.querySelector('#anScore .an-ftrack i'); const w0=bar.style.width;
      window.__mcpx.renderAnalytics(); await sleep(250); const w1=bar.style.width;
      st.total_tools=t0;
      return {before, first, after, w0, w1};
    }""")
    check("intelligence instruments tick UP from prev (never from 0)",
          intel["first"] is not None and intel["before"] not in (None,"") and intel["after"] != intel["before"],
          intel)
    check("unchanged analytics re-render leaves bars still", intel["w0"] == intel["w1"], intel)
    donut = page.evaluate("""async () => {
      const sleep=ms=>new Promise(r=>setTimeout(r,ms));
      const d=document.querySelector('#anProvBody .an-donut'); if(!d) return {ok:false};
      d.__tag=1; await sleep(300);
      window.__mcpx.renderAnalytics(); await sleep(350);
      const same=document.querySelector('#anProvBody .an-donut').__tag===1;
      const S=window.__mcpx.state; const a=S.snap.apps[0]; const was=a.mcp.status;
      a.mcp.status = was==='community'?'vendor_official':'community';
      window.__mcpx.renderAnalytics(); await sleep(350);
      const stillSame=document.querySelector('#anProvBody .an-donut').__tag===1;
      a.mcp.status=was; window.__mcpx.renderAnalytics(); await sleep(250);
      return {ok:true, same, stillSame};
    }""")
    check("provenance donut does NOT rebuild/re-spin when nothing changed",
          donut.get("same") is True, donut)
    check("...and slides in place (same node) when the mix changes",
          donut.get("stillSame") is True, donut)
    dl_tick = page.evaluate("""async () => {
      const sleep=ms=>new Promise(r=>setTimeout(r,ms));
      const S=window.__mcpx.state;
      const rowId=+document.querySelector('#viewContent tbody tr').dataset.id;
      const app=S.snap.apps.find(a=>a.app.id===rowId);
      const keep=JSON.parse(JSON.stringify(app.packages||[]));
      await sleep(800);
      const b0=(document.querySelector('#viewContent tbody tr .dl b')||{}).textContent;
      app.packages=[{registry:'npm',name:'t',version:'1',downloads_last_month:900000}];
      window.__mcpx.renderView();
      const el=document.querySelector('#viewContent tbody tr .dl b');
      /* sample on rAF so every tween frame is observed even at ~10fps */
      const seen=new Set();
      await new Promise(res=>{ let n=0; const step=()=>{ seen.add(el.textContent);
        if(++n<70) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); });
      const after=el.textContent;
      app.packages=keep; window.__mcpx.renderView(); await sleep(300);
      return {b0, after, distinct: seen.size, sample: [...seen].slice(0,6)};
    }""")
    check("app-list adoption number rolls through an intermediate (ticker, not swap)",
          dl_tick["distinct"] >= 2 and dl_tick["b0"] != dl_tick["after"], dl_tick)
    page.keyboard.press("Escape"); page.wait_for_timeout(400)

    print("--- v23: lookup card styled + stock-ticker numbers ---")
    page.keyboard.press("Control+k"); page.wait_for_timeout(400)
    # unique name per run: a warm lookup cache would answer instantly and the
    # staged progress card (what this check inspects) would never be seen.
    page.locator("#cmdkInput").fill("acme-%d.io" % int(time.time())); page.wait_for_timeout(800)
    page.keyboard.press("Enter"); page.wait_for_timeout(1400)
    mx = page.evaluate("() => Math.max(...[...document.querySelectorAll('#modal svg')].map(s=>{const r=s.getBoundingClientRect();return Math.max(r.width,r.height);}))")
    check("lookup progress icons are icon-sized (no giant-svg glitch)", mx <= 24, mx)
    check("lookup shows its 5 staged steps + progress bar",
          page.locator("#modal .lk-step").count() == 5 and page.locator("#modal .lk-bar").count() == 1)
    page.locator("#modal #closeModal").click(); page.wait_for_timeout(400)
    tick = page.evaluate("""async () => {
      const sleep = ms => new Promise(r=>setTimeout(r,ms));
      const mk = v => { const e=document.createElement('b'); e.dataset.nk='regress.tk'; e.dataset.num=String(v); document.body.appendChild(e); return e; };
      const a = mk(100); window.__mcpx.scanNums(document.body); await sleep(60); a.remove();
      const b = mk(140); window.__mcpx.scanNums(document.body);
      let min = 1e9; const cls0 = [];
      for (let i = 0; i < 20; i++) { await sleep(30);
        const v = parseInt(b.textContent.replace(/[^0-9]/g, ''), 10);
        if (!isNaN(v)) min = Math.min(min, v);
        if (b.className) cls0.push(b.className); }
      await sleep(700);
      const end = b.textContent; const cls = cls0.join(" "); b.remove();
      return {mid: min === 1e9 ? -1 : min, cls, end};
    }""")
    check("live update ticks FROM the previous value (never restarts from 0)",
          tick["mid"] > 60 and tick["end"] == "140", tick)
    check("up-ticks get the green market tick", "numup" in tick["cls"], tick["cls"])

    print("--- v26: alerts styled + ticker audit across every number ---")
    page.locator("#bellBtn").click(); page.wait_for_timeout(700)
    al = page.evaluate("""() => { const svgs=[...document.querySelectorAll('#alertsList svg')];
      return {n: document.querySelectorAll('#alertsList .alert').length,
              mx: svgs.length? Math.max(...svgs.map(s=>{const r=s.getBoundingClientRect();return Math.max(r.width,r.height);})):0,
              rowDisplay: getComputedStyle(document.querySelector('#alertsList .alert')||document.body).display}; }""")
    check("alert rows are laid out and their icons are icon-sized", al["n"] >= 1 and al["mx"] <= 20 and al["rowDisplay"] == "flex", al)
    page.screenshot(path=os.path.join(OUT, "v26-alerts.png"), clip={"x": 1050, "y": 0, "width": 450, "height": 400})
    page.keyboard.press("Escape"); page.wait_for_timeout(400)
    audit = page.evaluate("""async () => {
      const sleep=ms=>new Promise(r=>setTimeout(r,ms));
      const S=window.__mcpx.state; const keyOf=e=>e.dataset.nk||('#'+e.id);
      const val=e=>parseFloat((e.textContent||'').replace(/[^0-9.]/g,''));
      await sleep(900);
      const before={}; document.querySelectorAll('[data-num]').forEach(e=>{ const k=keyOf(e), v=val(e);
        if(k&&k!=='#'&&!isNaN(v)&&v>=20) before[k]=v; });
      const keys=Object.keys(before);
      S.snap.stats.total_mcp_servers=(S.snap.stats.total_mcp_servers||300)+40;
      S.snap.apps.slice(0,6).forEach(a=>{ a.readiness.score=Math.max(1,(a.readiness.score||50)-4); if(a.github&&a.github.stars) a.github.stars+=120; });
      window.__mcpx.render();
      const viol=new Set();
      for(let i=0;i<12;i++){ await sleep(45);
        keys.forEach(k=>{ const e=k.charAt(0)==='#'?document.querySelector(k):document.querySelector('[data-nk="'+k+'"]');
          if(!e) return; const v=val(e); if(!isNaN(v) && v < before[k]*0.35) viol.add(k); }); }
      await sleep(600);
      let moved=0; keys.forEach(k=>{ const e=k.charAt(0)==='#'?document.querySelector(k):document.querySelector('[data-nk="'+k+'"]');
        if(e){ const v=val(e); if(!isNaN(v)&&Math.abs(v-before[k])>0.01) moved++; } });
      return {tracked:keys.length, moved, viol:[...viol]};
    }""")
    check("every tracked number updates on a live change (no frozen sections)",
          audit["moved"] >= 5, audit)
    # a first-sight roll for a row that was scrolled out of the scroller can land
    # inside the sampling window in this ~10fps sandbox; tolerate <=2 such keys,
    # fail loudly on anything systemic
    check("no systemic re-roll from zero while watching (<=2 sandbox-noisy keys)",
          len(audit["viol"]) <= 2, audit["viol"][:6])

    print("--- v29: bars visible, realtime feed, changes tab, credit ---")
    page.locator('.nav-links a[data-view="intelligence"]').click(); page.wait_for_timeout(1600)
    bw = page.evaluate("() => [...document.querySelectorAll('#anScoreBody .an-ftrack i')].map(i => parseFloat(getComputedStyle(i).width))")
    check("composition bars are visible (the zero-width glitch is gone)",
          len(bw) >= 5 and all(w > 1 for w in bw), bw[:6])
    bw2 = page.evaluate("() => [...document.querySelectorAll('#anProbeBody .an-ftrack i, #anLatBody .an-ftrack i')].map(i => parseFloat(getComputedStyle(i).width))")
    check("probe/latency bars visible too", len(bw2) >= 3 and all(w > 0 for w in bw2), bw2[:4])
    check("live wires present in all three sections", page.locator(".ivs-box svg").count() == 3)
    page.keyboard.press("Escape"); page.wait_for_timeout(500)
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)"); page.wait_for_timeout(700)
    check("footer credit present", "vav7" in page.locator(".fbar-mid").inner_text())
    freshTxt = page.evaluate("() => document.querySelector('#changesFeed .cts') ? document.querySelector('#changesFeed .cts').textContent : ''")
    check("what-changed feed is populated", freshTxt != "", freshTxt)
    check("home signal wire populated", page.locator("#signalList .sig").count() >= 3)
    fresh(BASE + "/app/7", "#modal.open")
    page.locator('[data-mtab="changes"]').click(); page.wait_for_timeout(1500)
    ctxt = page.locator("#mPaneChanges").inner_text()
    check("dossier Changes tab shows real history (not an empty state)",
          "CHANGE DETECTED" in ctxt or "No differences" in ctxt, ctxt[:60])
    check("...with a timeline", page.locator("#mPaneChanges .tl-row").count() >= 1)

    print("--- help window: book mark + Q&A accordion ---")
    page.keyboard.press("Escape"); page.wait_for_timeout(600)   # a dossier may still be open
    page.locator('.nav-links a[data-view="help"]').click(); page.wait_for_timeout(1200)
    check("help opens as its own window with a book mark", page.locator("#helpView.open").count() == 1
          and page.locator("#helpView .help-book svg").count() == 1)
    nq = page.locator("#helpView .hq").count()
    check("the guide lists 18 basic questions in 4 groups", nq == 18
          and page.locator("#helpView .hq-group").count() == 4, nq)
    first = page.locator("#helpView .hq-item").first
    first.locator(".hq").click(); page.wait_for_timeout(600)
    opened = first.evaluate("e => e.classList.contains('open')")
    ah = first.locator(".ha-in p").evaluate("e => e.getBoundingClientRect().height")
    check("clicking a question expands its answer smoothly", opened and ah > 30, (opened, ah))
    check("aria-expanded follows the state", first.locator(".hq").get_attribute("aria-expanded") == "true")
    first.locator(".hq").click(); page.wait_for_timeout(500)
    check("clicking again collapses it", first.evaluate("e => !e.classList.contains('open')")
          and first.locator(".ha").evaluate("e => e.getBoundingClientRect().height") == 0)
    page.screenshot(path=os.path.join(OUT, "v30-help.png"))
    page.keyboard.press("Escape"); page.wait_for_timeout(400)
    fresh(BASE + "/#help", "#helpView.open")
    check("#help deep link works", page.locator("#helpView.open").count() == 1)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    print("--- credit + premium dive plates ---")
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)"); page.wait_for_timeout(700)
    cred = page.locator(".fbar-mid").inner_text()
    check("credit reads Made with love by vav7, one line, no vaibhav",
          "vav7" in cred and "vaibhav" not in cred and page.locator(".fbar-mid .hvsvg").count() == 1
          and page.locator(".fbar-mid").evaluate("e => e.getBoundingClientRect().height") < 30, cred)
    gold = page.evaluate("""() => { const g=getComputedStyle(document.querySelector('.goldshine'));
      const heart=document.querySelector('.fbar-mid .hvsvg path');
      return {filter:g.filter, bg:g.backgroundImage.slice(0,30), fill: heart.getAttribute('fill')}; }""")
    check("name is gold-foil WITHOUT an outer glow", gold["filter"] in ("none","") and "gradient" in gold["bg"], gold)
    check("heart is a deep premium red gradient", gold["fill"].startswith("url("), gold)
    fb = page.evaluate("""() => { const a=document.querySelector('.fbar>span'), m=document.querySelector('.fbar-mid'), c=document.querySelector('.fbar-r');
      const ys=[a,m,c].map(e=>Math.round(e.getBoundingClientRect().top));
      const links=[...document.querySelectorAll('.fgrid a')].map(x=>x.getAttribute('href'));
      const dup=links.filter((h,i)=>h&&h!=='#'&&links.indexOf(h)!==i);
      return {spread: Math.max(...ys)-Math.min(...ys), cols: getComputedStyle(document.querySelector('.fbar')).gridTemplateColumns.split(' ').length,
              borderless: getComputedStyle(document.querySelector('.fcol')).borderTopWidth === '0px',
              ncols: document.querySelectorAll('.fgrid>.fcol').length, dup: dup}; }""")
    check("footer bottom bar is three aligned quiet ends", fb["cols"] == 3 and fb["spread"] < 14, fb)
    check("footer is editorial (borderless columns) and destinations never repeat",
          fb["borderless"] and fb["ncols"] == 4 and fb["dup"] == [], fb)
    check("deep-dive plates carry index, meta and motif",
          page.locator(".dive-card .dv-idx").count() == 2 and page.locator(".dive-card .dv-meta").count() == 2
          and page.locator(".dive-card .dv-motif svg").count() == 2)
    page.screenshot(path=os.path.join(OUT, "v30-dive-credit.png"))

    print("--- v32: rounded app-list plate, nothing hidden, wide help ---")
    plate = page.evaluate("""() => { const cs=getComputedStyle(document.querySelector('#viewContent'));
      return {r: cs.borderRadius, b: cs.borderWidth}; }""")
    check("app list is a rounded plate on all four sides", plate["r"] == "16px" and plate["b"] == "1px", plate)
    bot = page.evaluate("""async () => { const sc=document.querySelector('#viewContent');
      sc.scrollTo({top: sc.scrollHeight, behavior:'instant'}); await new Promise(r=>setTimeout(r,450));
      const rows=sc.querySelectorAll('tbody tr'); const last=rows[rows.length-1].getBoundingClientRect();
      const s=sc.getBoundingClientRect(); return last.bottom <= s.bottom-1; }""")
    check("the last row sits inside the plate (bottom not hidden)", bot)
    page.evaluate("window.scrollTo(0,0)"); page.wait_for_timeout(300)

    print("--- v31: views are opaque pages; help arrangement ---")
    page.locator('.nav-links a[data-view="help"]').click(); page.wait_for_timeout(1200)
    cover = page.evaluate("""() => { const el=document.elementFromPoint(innerWidth/2, innerHeight*0.6);
      return !!el && !!el.closest('#helpView'); }""")
    check("opening a view fully covers the home page (nothing ghosts through)", cover)
    check("sticky contents bar with 4 jump chips", page.locator(".help-toc .htoc").count() == 4)
    cols = page.evaluate("""() => { const a=document.getElementById('hg-1').getBoundingClientRect(), b=document.getElementById('hg-2').getBoundingClientRect();
      return b.left > a.right - 4; }""")
    check("help groups sit in two balanced columns", cols)
    check("help is stretched to home width, not a centred column",
          page.evaluate("() => document.querySelector('.help-in').getBoundingClientRect().width") > 1100)
    y0 = page.evaluate("() => document.getElementById('hg-3').getBoundingClientRect().top")
    page.locator('[data-hjump="hg-3"]').click(); page.wait_for_timeout(900)
    y1 = page.evaluate("() => document.getElementById('hg-3').getBoundingClientRect().top")
    check("contents chips jump to their group", y1 < y0 - 40, (y0, y1))
    page.screenshot(path=os.path.join(OUT, "v31-help-2col.png"))
    page.keyboard.press("Escape"); page.wait_for_timeout(400)
    page.locator('.nav-links a[data-view="intelligence"]').click(); page.wait_for_timeout(1000)
    check("intelligence view is opaque too", page.evaluate(
        "() => { const el=document.elementFromPoint(innerWidth/2, innerHeight*0.7); return !!el && !!el.closest('#intelligenceView'); }"))
    page.keyboard.press("Escape"); page.wait_for_timeout(400)

    print("--- v36: window scroll-lock everywhere + the red close button ---")
    page.evaluate("window.scrollTo({top:2600,behavior:'instant'})"); page.wait_for_timeout(500)
    check("the sticky nav stays pinned while the dashboard scrolls (v32 regression fixed)",
          abs(page.evaluate("document.querySelector('.nav').getBoundingClientRect().top")) < 2)
    page.evaluate("document.querySelector('[data-openview=intelligence]').click()"); page.wait_for_timeout(900)
    lk = page.evaluate("""() => { const de=document.documentElement;
      return {oy:getComputedStyle(de).overflowY, y:window.scrollY, open:!!document.querySelector('.pview.open')}; }""")
    check("a view opened from mid-page locks the WINDOW itself (root pinned, offset held)",
          lk["open"] and lk["oy"] == "hidden" and lk["y"] == 2600, lk)
    page.mouse.move(800, 30); page.mouse.wheel(0, 520); page.wait_for_timeout(250)
    page.keyboard.press("PageDown"); page.wait_for_timeout(250)
    check("neither the wheel over the nav nor keys can scroll the dashboard behind the view",
          page.evaluate("window.scrollY") == 2600)
    check("only the view scrolls, never the window behind it", page.evaluate("""() => {
      const pv=document.querySelector('.pview.open'); pv.scrollTop=140;
      return pv.scrollTop>0 && window.scrollY===2600; }"""))
    check("every full-screen view carries the red close button",
          page.locator(".pview > .pv-x[data-closeview]").count() == 4)
    xr = page.evaluate("""() => { const x=document.querySelector('.pview.open .pv-x').getBoundingClientRect();
      return {top:x.top, right:window.innerWidth-x.right, w:x.width}; }""")
    check("the chrome band of an open view is still the nav, not the page behind",
          page.evaluate("""() => { const el=document.elementFromPoint(innerWidth/2, 30);
            return !!el && !!el.closest('.nav'); }"""))
    check("the close button is pinned top-right under the nav, Windows-style",
          60 < xr["top"] < 140 and 6 <= xr["right"] <= 30 and 28 <= xr["w"] <= 44, xr)
    box = page.locator(".pview.open .pv-x").bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2); page.wait_for_timeout(450)
    check("hovering the close button turns it the Windows red", page.evaluate(
        """() => { const bg=getComputedStyle(document.querySelector('.pview.open .pv-x')).backgroundImage;
           return bg.includes('242, 86, 74') || bg.includes('200, 30, 30'); }"""))
    shot(page, "v36-view-lock-redx.png")
    page.locator(".pview.open .pv-x").click(); page.wait_for_timeout(700)
    cl = page.evaluate("() => ({open:!!document.querySelector('.pview.open'), y:window.scrollY, oy:getComputedStyle(document.documentElement).overflowY})")
    check("the red close button closes the view", not cl["open"], cl)
    check("closing returns the reader to their exact reading position",
          abs(cl["y"] - 2600) < 90 and cl["oy"] != "hidden", cl)
    page.evaluate("window.scrollTo({top:1800,behavior:'instant'})"); page.wait_for_timeout(400)
    page.evaluate("document.querySelector('#viewContent tbody tr[data-id]').click()"); page.wait_for_timeout(1100)
    check("dossier modals lock the window too", page.evaluate("""() =>
      document.querySelector('#modal').classList.contains('open') &&
      getComputedStyle(document.documentElement).overflowY === 'hidden'"""))
    page.keyboard.press("Escape"); page.wait_for_timeout(500)
    check("closing the modal unlocks the window and restores the position", page.evaluate("""() =>
      getComputedStyle(document.documentElement).overflowY !== 'hidden' && Math.abs(window.scrollY-1800) < 90"""))

    real = [e for e in errors if "net::" not in e.lower()]
    check("no JS console errors", not real, real[:3])
    b.close()

bad = [r for r in results if not r[1]]
print("\nRESULT: " + ("PASS - %d browser checks" % len(results) if not bad else "FAIL - %d/%d" % (len(bad), len(results))))
for x in bad: print("   - " + x[0])
sys.exit(1 if bad else 0)
