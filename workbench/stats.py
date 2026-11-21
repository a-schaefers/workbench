"""The pane's Stats tab: its settings (stats.json, `wb stats set`), read by the runner (what a
task records for it) and by `wb top` and the mod (the live view). The user's rule (2026-11-20):
a measurement that costs nothing is on by default, and every one can be turned off. The feed:
everything workbench has learned, for the tab's history (`wb stats --json`, #405)."""
import time
from collections import Counter, defaultdict
from datetime import date, timedelta
from statistics import median

from . import store

DEFAULTS = {"recording": True, "live": True, "every": 2}
EVERY = (1, 2, 5)  # seconds between the live view's samples (wb top)
SWITCHES = ("recording", "live")


def path():
    return store.home() / "stats.json"


def settings() -> dict:
    """The settings, each its default unless stats.json says otherwise (a value of the wrong
    type, hand-edited, is ignored rather than trusted)."""
    data = store.read_json(path(), {})
    if not isinstance(data, dict):  # the runner reads this every round: never a reason to fail
        data = {}
    out = dict(DEFAULTS)
    for key in SWITCHES:
        if isinstance(data.get(key), bool):
            out[key] = data[key]
    if data.get("every") in EVERY:
        out["every"] = data["every"]
    return out


def recording() -> bool:
    """Whether a task records what only the Stats tab reads (its row's speeds, watts, guards and
    timings; the round_end event). What the router, tuning and savings read is always kept."""
    return settings()["recording"]


def set_setting(key: str, value: str) -> dict:
    """`wb stats set KEY VALUE`. Raises ValueError with the allowed values. Under stats.lock: two
    settings picked at once (two sessions' rows, the pane and a shell) each wrote back the snapshot
    it read, and one was lost while both said it took (#564)."""
    if key in SWITCHES:
        if value not in ("on", "off"):
            raise ValueError(f"{key} is on or off")
        change = {key: value == "on"}
    elif key == "every":
        if value not in {str(s) for s in EVERY}:
            raise ValueError(f"every is one of {', '.join(map(str, EVERY))} (seconds)")
        change = {"every": int(value)}
    else:
        raise ValueError(f"no setting {key!r}: recording, live or every")
    with store.locked(path().with_suffix(".lock")):
        data = store.read_json(path(), {})
        data = data if isinstance(data, dict) else {}
        store.write_json(path(), {**data, **change, "ts": store.now()})
    return settings()


def line() -> str:
    s = settings()
    return (f"stats: recording {'on' if s['recording'] else 'off'} · live view "
            f"{'on' if s['live'] else 'off'} · every {s['every']} s")


# The feed (#405): everything workbench has learned, as one object for the Stats tab (`wb stats
# --json`). Built from what already computes it; a section with no data is left out, never a
# zero, and the savings are the estimate savings.py labels as one.
MILESTONES_LANDED = (1, 10, 25, 50, 100, 250, 500, 1000)
MILESTONES_SAVED = (100_000, 1_000_000, 10_000_000, 100_000_000)  # Claude tokens, estimated
TREND_MIN = 6  # speed samples (tasks) before a model's trend is given


def _day(ts: float | None) -> str | None:
    return time.strftime("%Y-%m-%d", time.localtime(ts)) if ts else None  # a row too old to say


def _midnight(now: float) -> float:
    """The next local midnight after ``now``: the feed holds until then (its streak, its 7 and 30
    days and its periods are counted from today), so the pane reads it again once it passes, files
    unchanged or not (#575)."""
    t = time.localtime(now)
    return time.mktime((t.tm_year, t.tm_mon, t.tm_mday + 1, 0, 0, 0, 0, 0, -1))


def _landed(r: dict) -> bool:
    return r.get("outcome") == "accepted"


def _mean(xs: list) -> float | None:
    xs = [x for x in xs if isinstance(x, (int, float))]
    return round(sum(xs) / len(xs), 1) if xs else None


def _streak(rows: list[dict], now: float) -> dict | None:
    """Days in a row with a task landed: the current run (ending today, or yesterday while today
    has none yet) and the best."""
    days = sorted({_day(r["ts"]) for r in rows if _landed(r) and r.get("ts")})
    if not days:
        return None
    best = run = 1
    gap = lambda a, b: (date.fromisoformat(b) - date.fromisoformat(a)).days  # noqa: E731
    for a, b in zip(days, days[1:]):
        run = run + 1 if gap(a, b) == 1 else 1
        best = max(best, run)
    current = 0
    today = date.fromtimestamp(now)  # dates, not now - 86400: a 23- or 25-hour day skipped one (#563)
    if days[-1] in (today.isoformat(), (today - timedelta(days=1)).isoformat()):
        current, i = 1, len(days) - 1
        while i > 0 and gap(days[i - 1], days[i]) == 1:
            current, i = current + 1, i - 1
    return {"current": current, "best": best, "days": len(days)}


def _bests(rows: list[dict]) -> dict:
    """The most lines landed first try, and the fastest landing. First try is skills.py's: landed
    with no review round the agent caused. Not the runner's round counter: self-review, a handover
    and a steer each add a round Claude never saw, so a default `--test` task never qualified
    (#550)."""
    from . import tuning
    out = {}
    # the agent's own landings: a task Claude finished after wb takeover is Claude's work (#566),
    # as progress.helped leaves it out
    rows = [r for r in rows if not tuning.took_over(r)]
    first_try = [r for r in rows if _landed(r) and not tuning.agent_reviews(r) and r.get("diff")]
    if first_try:
        big = max(first_try, key=lambda r: r["diff"].get("added", 0) + r["diff"].get("removed", 0))
        out["largest_first_try"] = {"task": big.get("task"), "ts": big.get("ts"),
                                    "lines": big["diff"].get("added", 0) + big["diff"].get("removed", 0)}
    timed = [r for r in rows if _landed(r) and isinstance(r.get("minutes"), (int, float))]
    if timed:
        fast = min(timed, key=lambda r: r["minutes"])
        out["fastest"] = {"task": fast.get("task"), "ts": fast.get("ts"), "minutes": fast["minutes"]}
    return out


def _milestones(rows: list[dict]) -> list[dict]:
    """Each milestone reached, with its day: tasks landed, and Claude tokens saved (estimate),
    the saving over the same rows as savings.totals, spec-gap discards and all: over the judged
    rows alone it reached 100K that the all-time saving never did (#569)."""
    from . import savings
    out, landed, saved = [], 0, 0
    marks_l, marks_s = list(MILESTONES_LANDED), list(MILESTONES_SAVED)
    for r in sorted(rows, key=lambda r: r.get("ts") or 0):
        if _landed(r):
            landed += 1
            while marks_l and landed >= marks_l[0]:
                out.append({"kind": "landed", "n": marks_l.pop(0), "day": _day(r.get("ts"))})
        if (p := savings.of_row(r)) is not None:
            saved += p["saved"]
            while marks_s and saved >= marks_s[0]:
                out.append({"kind": "saved", "n": marks_s.pop(0), "day": _day(r.get("ts"))})
    return out


def _absorbed(rows: list[dict]) -> dict:
    """Work that never reached Claude: auto-fix rounds (attempts, whatever came of them) and the
    tasks whose tests then passed, and handovers in tasks that went on to land. A question isn't
    here: its notice wakes Claude (#562)."""
    fixed = [r for r in rows if (r.get("auto_fixes") or 0) > 0]
    out = {"auto_fixes": sum(r["auto_fixes"] for r in fixed),
           "auto_fixed_tasks": sum(1 for r in fixed if r.get("tests_ok")),
           "handovers_landed": sum(1 for r in rows if _landed(r)
                                   and any((s.get("handovers") or 0) > 0 for s in r.get("steps") or []))}
    return {k: v for k, v in out.items() if v}


def _questions(rows: list[dict]) -> dict:
    """The agents' ask_reviewer questions: asked, and answered by `wb answer` (a row before
    `answered` was recorded counts as asked only: never more answered than known, #562)."""
    asks = [r.get("asks") or {} for r in rows]
    out = {"asked": sum(a.get("questions", 0) for a in asks),
           "answered": sum(a.get("answered", 0) for a in asks)}
    return {k: v for k, v in out.items() if v}


def _models(rows: list[dict]) -> dict:
    by = defaultdict(list)
    for r in rows:
        if r.get("model"):
            by[r["model"]].append(r)
    return {model: _model_stats(model, rs) for model, rs in by.items()}


# The tab's model lines (#638, the owner, 2026-11-21): every model that ever ran a task, forever,
# each `wb optimize` window its own line, in no order; after 49 tasks the tab listed five, two of
# them variants of a third and one long gone. Shown: the models OpenCode has now, a variant folded
# under its source, the most recently used first; the rest on one line. `models` keeps them all.
OLD_DAYS = 90
# At most this many of them (the owner, 2026-11-21): a machine with a model a week tried for a
# year drew a line each, and the tab's menu sat a long scroll below a new user's first look.
# The rest are counted in `more`; `wb stats --all` and `wb models` still show every one.
STATS_MODEL_LINES = 3


def _model_lines(rows: list[dict], now: float) -> dict | None:
    """{"lines": [{model, variants, windows, last, …_model_stats}], "more": {models, tasks},
    "older": {models, tasks}}: the newest STATS_MODEL_LINES lines, the other recent ones in
    `more`, the retired and long-idle in `older` (each only when it counts any)."""
    from . import models
    try:
        found = models.discover()
    except Exception:  # the feed never fails over a config it can't read
        found = {}
    over = models._overrides()  # a retired variant still folds under its source
    # an id a model had before (models.json `renamed_from`; an Ollama digest it now runs under
    # another id, router.earlier without a server read: from the rows' own weights_id) folds
    # under the id it has now, not into "older" (#818)
    newer = {old: k for k, v in over.items() if isinstance(v, dict)
             for old in _renames(over, k)}
    weights = {r["model"]: r.get("weights_id") for r in rows if r.get("model")}
    digest = {w: k for k, w in weights.items() if k in found and w and w.startswith("ollama:")}
    newer.update({k: digest[w] for k, w in weights.items()
                  if k not in found and k not in newer and w in digest})

    def base(mid: str) -> str:
        mid = newer.get(mid, mid)
        return ((over.get(mid) or {}) if isinstance(over.get(mid), dict) else {}).get("variant_of") or mid
    sources = {base(m) for m in found} | set(found)
    groups = defaultdict(list)
    for r in rows:
        if r.get("model"):
            groups[base(r["model"])].append(r)
    lines, older = [], {"models": 0, "tasks": 0}
    for b, rs in groups.items():
        last = max((r.get("ts") or 0 for r in rs), default=0)
        if b not in sources or (last and now - last > OLD_DAYS * 86400):
            older["models"] += 1
            older["tasks"] += len(rs)
            continue
        newest = max(rs, key=lambda r: r.get("ts") or 0)["model"]
        # a configured variant that ran nothing yet folds here too: its optimized window and
        # bench run are this line's, not "1 more" beside it (2026-11-21)
        ids = {r["model"] for r in rs} | {m for m in found if base(m) == b}
        lines.append({"model": b, "variants": sorted(ids),
                      "windows": sorted({r["window"] for r in rs if isinstance(r.get("window"), int)}),
                      "last": last, **_model_stats(newest, rs)})
    lines.sort(key=lambda x: -x["last"])
    if not lines and not older["models"]:
        return None
    rest = lines[STATS_MODEL_LINES:]
    more = {"models": len(rest), "tasks": sum(x["tasks"] for x in rest)}
    return {"lines": lines[:STATS_MODEL_LINES], **({"more": more} if rest else {}),
            **({"older": older} if older["models"] else {})}


def _renames(over: dict, model_id: str) -> list[str]:
    from . import router
    return router._up(over, model_id, "renamed_from")


def _model_stats(model: str, rs: list[dict]) -> dict:
    """One model's record over ``rs``; its speeds (router.speed) are ``model``'s."""
    from . import router, spend
    n, landed = len(rs), sum(map(_landed, rs))
    claude = [spend.weighted(r["claude"]) for r in rs if isinstance(r.get("claude"), dict)]
    m = {"tasks": n, "landed": landed, "accepted_pct": round(100 * landed / n),
         "rounds": _mean([r.get("rounds") for r in rs]),
         "auto_fixes": _mean([r.get("auto_fixes") for r in rs]),
         "reviews": _mean([r.get("reviews") for r in rs]),
         "minutes": _mean([r.get("minutes") for r in rs]),
         "local_tokens": round(sum((r.get("tok_in") or 0) + (r.get("tok_out") or 0) for r in rs) / n),
         **({"claude": round(sum(claude) / len(claude))} if claude else {}),
         **({"speed": sp} if (sp := router.speed(model)) else {})}
    trend = [[r["ts"], r["speed"]["write"]] for r in sorted(rs, key=lambda r: r.get("ts") or 0)
             if r.get("ts") and isinstance(r.get("speed"), dict) and r["speed"].get("write")]
    if trend:
        m["write_trend"] = trend[-30:]
    if len(trend) >= TREND_MIN:  # the newest third against the oldest third, medians
        k = len(trend) // 3
        old, new = median(v for _, v in trend[:k]), median(v for _, v in trend[-k:])
        if old:
            m["write_change_pct"] = round(100 * (new - old) / old)
    return {k: v for k, v in m.items() if v is not None}


def _by(rows: list[dict], key) -> dict:
    by = defaultdict(list)
    for r in rows:
        for k in key(r):
            by[k].append(r)
    return {k: {"tasks": len(rs), "accepted_pct": round(100 * sum(map(_landed, rs)) / len(rs))}
            for k, rs in by.items()}


def _days(rows: list[dict], now: float, n: int = 30) -> list[dict]:
    today = date.fromtimestamp(now)  # local dates: now - i * 86400 skipped or repeated a day at DST (#563)
    want = [(today - timedelta(days=i)).isoformat() for i in range(n - 1, -1, -1)]
    tasks, landed = defaultdict(int), defaultdict(int)
    for r in rows:
        if r.get("ts"):
            d = _day(r["ts"])
            tasks[d] += 1
            landed[d] += _landed(r)
    return [{"day": d, "tasks": tasks[d], "landed": landed[d]} for d in want]


def _bench() -> dict:
    """Each model's newest finished bench run, the cases passed of those graded, and a newer run
    still going or cut short as `partial` beside it ({run, day, passed, of, planned, running}),
    never in its place: the newest run's first graded case read "1/1" as the model's result,
    for good if the run was stopped (#570). A run is finished for a model once each of its
    planned replays (plan.json's pairs on it, times repeat) has settled: graded, or didn't start
    (an error, which drive doesn't retry). A run with no plan is taken as finished."""
    from . import bench
    every = [r for r in store.read_jsonl(bench.runs_file())[0]
             if isinstance(r, dict) and r.get("model") and r.get("arm") != "claude"]
    graded = defaultdict(list)
    settled = defaultdict(set)
    for r in every:
        key = (r["model"], r.get("run"))
        if r.get("outcome") in ("passed", "failed"):
            graded[key].append(r)
        if r.get("outcome") in ("passed", "failed", "error"):
            settled[key].add((r.get("case"), r.get("rep", 1)))
    plans: dict = {}
    running = (bench.driver() or {}).get("run")

    def planned(model, run) -> int | None:
        if run not in plans:
            plans[run] = bench.plan(run) if isinstance(run, str) and run else {}
        p = plans[run]
        if not p.get("pairs"):
            return None
        return sum(1 for _, m in p["pairs"] if m == model) * int(p.get("repeat") or 1)

    out: dict = {}
    for (model, run), rs in sorted(graded.items(), key=lambda kv: max(r.get("ts", 0) for r in kv[1])):
        ts = max(r.get("ts", 0) for r in rs)
        line = {"run": run, "day": _day(ts), "passed": sum(r["outcome"] == "passed" for r in rs), "of": len(rs)}
        n = planned(model, run)
        m = out.setdefault(model, {})
        if n is None or len(settled[(model, run)]) >= n:
            m.pop("partial", None)  # a newer run finished: the older partial is history
            m.update(line)
        else:
            m["partial"] = {**line, "planned": n, "running": run == running}
    return out


def _optimized() -> dict:
    data = store.read_json(store.machine_dir() / "optimize.json", {}) or {}  # optimize.path
    models = data.get("models") if isinstance(data, dict) else None
    return {m: {k: v[k] for k in ("window", "fits", "spill", "ts") if k in v}
            for m, v in (models or {}).items() if isinstance(v, dict) and v.get("window")}


def _helps(rows: list[dict]) -> dict:
    """progress.helped for each model a progress check's answer was tried on, over the feed's
    rows (one pass: a read per model was most of the feed's time on a long history, #565)."""
    from . import progress
    return {m: h for m, h in progress.helped_by_model(rows).items()
            if m and any(n for _, n in h.values())}


def _energy(rows: list[dict], price: float | None) -> dict | None:
    """A period's GPU energy: every row that measured it (`gpu_wh`; another machine's GPU,
    `remote_gpu`, measured nothing here), compared by savings or not. savings.totals sums only
    the rows it can compare, so a period's tasks run outside a session lost their watt-hours
    (#568). The cost with a price set."""
    whs = [r["gpu_wh"] for r in rows if isinstance(r.get("gpu_wh"), (int, float))
           and not isinstance(r["gpu_wh"], bool) and not r.get("remote_gpu")]
    if not whs:
        return None
    wh = round(sum(whs), 1)
    return {"wh": wh, **({"cost": round(wh / 1000 * price, 2)} if price is not None else {})}


SUMMARY = ("periods", "streak", "absorbed", "questions", "guards")  # what `wb stats` shows of the feed


def feed(now: float | None = None, only: tuple | None = None) -> dict:
    """`wb stats --json`: the Stats tab's history (#405). results.jsonl is read once and that
    snapshot passed down: each period's savings and each model's helps read it again, 16 reads
    of a 4,800-row history per feed (#565). ``only``: these sections alone (`wb stats`)."""
    from . import savings, tuning
    now = store.now() if now is None else now
    every = store.results()
    rows = [r for r in every if tuning.judged(r)]  # trials and spec-gap discards out
    out: dict = {"ts": now, "until": _midnight(now), "settings": settings(), "tasks": len(rows)}
    price = savings.price()
    periods = {}
    for name, span in savings.PERIODS.items():
        since = now - span if span else 0
        rs = [r for r in rows if (r.get("ts") or 0) >= since]
        t = savings.totals(every, since=since)
        # in the saving (Claude's tokens were spent) but not the task count: said beside it (#569)
        gaps = sum(1 for r in every if (r.get("ts") or 0) >= since and not tuning.judged(r))
        energy = _energy([r for r in every if (r.get("ts") or 0) >= since], price)
        if rs or t["tasks"] or gaps or energy:
            landed = sum(map(_landed, rs))
            periods[name] = {"tasks": len(rs), "landed": landed,
                             **({"accepted_pct": round(100 * landed / len(rs))} if rs else {}),
                             **({"spec_gaps": gaps} if gaps else {}),
                             **({"energy": energy} if energy else {}),
                             # nothing to compare: no savings, rather than a row of zeros
                             **({"savings": t, "score": savings.score(t)} if t["tasks"] else {}),
                             **({"active_minutes": am} if (am := round(sum(r.get("active_minutes") or 0
                                                                           for r in rs), 1)) else {})}
    sections = {
        "periods": lambda: periods,
        "streak": lambda: _streak(rows, now),
        "bests": lambda: _bests(rows),
        # every row: a spec-gap discard still cost Claude, as in each period's saving (#569)
        "milestones": lambda: _milestones(every),
        "absorbed": lambda: _absorbed(rows),
        "questions": lambda: _questions(rows),
        "models": lambda: _models(rows),
        "model_lines": lambda: _model_lines(rows, now),
        "sizes": lambda: _by(rows, lambda r: [r["size"]] if r.get("size") else []),
        "stacks": lambda: _by(rows, lambda r: r.get("stack") or []),
        "days": lambda: _days(rows, now) if rows else None,
        "guards": lambda: dict(sum((Counter(r.get("guards") or {}) for r in rows), Counter())),
        "helps": lambda: _helps(rows),
        "bench": _bench,
        "optimized": _optimized,
    }
    for k, make in sections.items():
        if only is None or k in only:
            if v := make():
                out[k] = v
    return out


def summary(f: dict) -> list[str]:
    """`wb stats`' lines above its table: the feed's headline, short (Claude reads it too)."""
    lines = []
    for name in ("week", "all"):
        p = f.get("periods", {}).get(name)
        if not p:
            continue
        s, saved = p.get("score"), (p.get("savings") or {}).get("saved", 0)
        said = (f"saved ~{saved / 1000:.0f}K" if saved >= 0 else f"cost ~{-saved / 1000:.0f}K more")
        lines.append(f"{'this week' if name == 'week' else 'all time'}: {p['tasks']} task(s), "
                     f"{p['landed']} landed" + (f" ({p['accepted_pct']}%)" if "accepted_pct" in p else "")
                     + (f", and {p['spec_gaps']} discard(s) put down to the spec" if p.get("spec_gaps") else "")
                     + (f" · {said} Claude tokens (estimate) · score {s['score']}/100" if s else ""))
    if st := f.get("streak"):  # a run that ended isn't mentioned: only the best (the plan's rule)
        lines.append(f"streak: {st['current']} day(s) in a row with a task landed · best {st['best']}"
                     if st["current"] else f"best streak: {st['best']} day(s) in a row with a task landed")
    if ab := f.get("absorbed"):
        parts = []
        if ab.get("auto_fixes"):
            parts.append(f"{ab['auto_fixes']} auto-fix round(s), {ab.get('auto_fixed_tasks', 0)} task(s) then green")
        if ab.get("handovers_landed"):
            parts.append(f"{ab['handovers_landed']} landed after a handover")
        lines.append("without waking Claude: " + " · ".join(parts))
    if q := f.get("questions"):
        lines.append(f"questions: {q.get('asked', 0)} asked mid-task"
                     + (f", {q['answered']} answered" if q.get("answered") else ""))
    if g := f.get("guards"):
        lines.append("what stopped agents: " + " · ".join(f"{k} {v}" for k, v in
                                                        sorted(g.items(), key=lambda kv: -kv[1])))
    return lines
