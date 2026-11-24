const API = 'https://api.sleeper.app/v1';
const $ = (id) => document.getElementById(id);
const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(n);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function getJSON(path) {
    const res = await fetch(API + path);
    if (!res.ok) throw new Error(`Sleeper API ${res.status} for ${path}`);
    return res.json();
}

function completedWeeks(league, state) {
    const start = league.settings.start_week || 1;
    const lastRegular = (league.settings.playoff_week_start || 15) - 1;
    let last = lastRegular;
    if (league.status !== 'complete' && String(state.season) === String(league.season)) {
        last = Math.min(lastRegular, state.week - 1);
    } else if (league.status === 'pre_draft' || league.status === 'drafting') {
        last = start - 1;
    }
    const weeks = [];
    for (let w = start; w <= last; w++) weeks.push(w);
    return { weeks, lastTxWeek: Math.max(last + 1, state.week || 0, 1) };
}

function weeklyBonuses(matchupsByWeek) {
    const result = [];
    for (const [week, matchups] of matchupsByWeek) {
        const scores = matchups.map((m) => ({ rosterId: m.roster_id, points: m.custom_points ?? m.points ?? 0 }));
        if (!scores.length || scores.every((s) => !s.points)) continue;
        const hi = Math.max(...scores.map((s) => s.points));
        const lo = Math.min(...scores.map((s) => s.points));
        result.push({
            week,
            top: scores.filter((s) => s.points === hi),
            low: scores.filter((s) => s.points === lo),
        });
    }
    return result;
}

function buildLedgers(rosters, txByWeek, bonuses, budget) {
    const ledgers = new Map(rosters.map((r) => [r.roster_id, []]));
    const push = (rid, entry) => ledgers.get(rid)?.push(entry);

    for (const [week, txs] of txByWeek) {
        for (const t of txs) {
            if (t.status !== 'complete') continue;
            const ts = t.status_updated || t.created || 0;
            if (t.type === 'waiver') {
                const bid = t.settings?.waiver_bid || 0;
                if (!bid) continue;
                push(t.roster_ids[0], { week, order: 0, ts, kind: 'spend', amount: -bid, adds: Object.keys(t.adds || {}), drops: Object.keys(t.drops || {}) });
            }
            for (const wb of t.waiver_budget || []) {
                push(wb.sender, { week, order: 0, ts, kind: 'trade', amount: -wb.amount, other: wb.receiver });
                push(wb.receiver, { week, order: 0, ts, kind: 'trade', amount: wb.amount, other: wb.sender });
            }
        }
    }
    for (const b of bonuses) {
        for (const s of b.top) push(s.rosterId, { week: b.week, order: 1, ts: 0, kind: 'top', amount: CONFIG.topScorerBonus, points: s.points, tie: b.top.length > 1 });
        for (const s of b.low) push(s.rosterId, { week: b.week, order: 1, ts: 0, kind: 'low', amount: CONFIG.lowScorerBonus, points: s.points, tie: b.low.length > 1 });
    }

    const out = new Map();
    for (const r of rosters) {
        const entries = ledgers.get(r.roster_id).sort((a, b) => a.week - b.week || a.order - b.order || a.ts - b.ts);
        let real = budget;
        let spent = 0, earned = 0, traded = 0, tops = 0, lows = 0;
        for (const e of entries) {
            real += e.amount;
            e.balance = real;
            if (e.kind === 'spend') spent -= e.amount;
            else if (e.kind === 'trade') traded += e.amount;
            else { earned += e.amount; e.kind === 'top' ? tops++ : lows++; }
        }
        const shouldShow = Math.min(budget, real);
        const actual = budget - (r.settings?.waiver_budget_used || 0);
        out.set(r.roster_id, { entries, real, spent, earned, traded, tops, lows, shouldShow, actual, fix: shouldShow - actual, banked: real - shouldShow });
    }
    return out;
}

let players = null;
let state = null;

function playerName(id) {
    const p = players?.[id];
    if (!p) return players ? id : '…';
    const name = p.first_name ? `${p.first_name} ${p.last_name}` : (p.full_name || id);
    return p.position ? `${name} (${p.position}${p.team ? ' ' + p.team : ''})` : name;
}

function avatarHTML(user) {
    return user?.avatar
        ? `<img src="https://sleepercdn.com/avatars/thumbs/${esc(user.avatar)}" alt="" loading="lazy">`
        : '<span class="avatar-ph"></span>';
}

function entryDesc(e) {
    switch (e.kind) {
        case 'spend': {
            const add = e.adds.map(playerName).join(', ');
            const drop = e.drops.length ? ` <span class="muted hide-sm">(dropped ${esc(e.drops.map(playerName).join(', '))})</span>` : '';
            return `Won waiver: <b>${esc(add)}</b>${drop}`;
        }
        case 'trade':
            return `${e.amount > 0 ? 'Received FAAB in trade from' : 'Traded FAAB to'} ${esc(state.teamName(e.other))}`;
        case 'top':
            return `<span class="badge top">High score</span> ${e.points.toFixed(2)} pts${e.tie ? ' (tie)' : ''}`;
        case 'low':
            return `<span class="badge low">Low score</span> ${e.points.toFixed(2)} pts${e.tie ? ' (tie)' : ''}`;
    }
    return '';
}

function detailHTML(row, budget) {
    const s = row.stats;
    const lines = s.entries.map((e) => `
        <tr class="${e.kind === 'spend' ? '' : e.kind === 'trade' ? 'trade' : 'reward'}">
            <td>Wk ${e.week}</td>
            <td class="desc">${entryDesc(e)}</td>
            <td class="num ${e.amount < 0 ? 'neg' : 'pos'}">${e.amount > 0 ? '+' : ''}${money(e.amount)}</td>
            <td class="num">${money(e.balance)}${e.balance > budget ? ' <span class="badge bank">over cap</span>' : ''}</td>
        </tr>`).join('');
    let summary = `${money(budget)} start − ${money(s.spent)} spent + ${money(s.earned)} bonuses`;
    if (s.traded) summary += ` ${s.traded > 0 ? '+' : '−'} ${money(Math.abs(s.traded))} traded`;
    summary += ` = <b>${money(s.real)}</b> real balance.`;
    if (s.banked > 0) summary += ` Sleeper caps at ${money(budget)}, so <b>${money(s.banked)}</b> is banked.`;
    if (s.fix > 0) summary += ` <span class="neg"><b>Add ${money(s.fix)}</b> in Sleeper (shows ${money(s.actual)}, should show ${money(s.shouldShow)}).</span>`;
    if (s.fix < 0) summary += ` <span class="neg"><b>Remove ${money(-s.fix)}</b> in Sleeper (shows ${money(s.actual)}, should show ${money(s.shouldShow)}).</span>`;
    return `
        <div class="ledger-summary">${summary}</div>
        ${s.entries.length ? `<table class="ledger">
            <thead><tr><th>Week</th><th>What happened</th><th class="num">Amount</th><th class="num">Real balance</th></tr></thead>
            <tbody>${lines}</tbody>
        </table>` : '<p class="muted small">No FAAB spends or bonuses yet.</p>'}`;
}

function render() {
    const { rows, bonuses, budget, weeks } = state;
    $('weeks-counted').textContent = weeks.length ? `Weeks ${weeks[0]}–${weeks[weeks.length - 1]} counted` : 'No completed weeks yet';

    $('balance-rows').innerHTML = rows.map((row) => {
        const s = row.stats;
        const bad = s.fix !== 0;
        const fix = s.fix > 0 ? `<span class="fix add">Add ${money(s.fix)}</span>`
            : s.fix < 0 ? `<span class="fix add">Remove ${money(-s.fix)}</span>`
            : '<span class="fix ok">OK</span>';
        const badges = (s.tops ? `<span class="badge top">${s.tops}× high</span>` : '') + (s.lows ? `<span class="badge low">${s.lows}× low</span>` : '');
        return `
        <tr class="team ${bad ? 'bad' : ''} ${row.open ? 'open' : ''}" data-rid="${row.rosterId}">
            <td><div class="team-cell"><span class="caret">▶</span>${avatarHTML(row.user)}<div class="names"><span>${esc(row.displayName)}</span><span class="sub hide-sm">${esc(row.teamName)}</span></div></div></td>
            <td class="num hide-sm">${money(s.spent)}</td>
            <td class="num"><span class="pos">+${money(s.earned)}</span><div>${badges}</div></td>
            <td class="num big">${money(s.real)}${s.banked > 0 ? `<div><span class="badge bank">${money(s.banked)} banked</span></div>` : ''}</td>
            <td class="num hide-sm">${money(s.shouldShow)}</td>
            <td class="num actual">${money(s.actual)}</td>
            <td class="num">${fix}</td>
        </tr>
        <tr class="detail ${row.open ? '' : 'hidden'}" data-detail="${row.rosterId}"><td colspan="7">${row.open ? detailHTML(row, budget) : ''}</td></tr>`;
    }).join('');

    const bad = rows.filter((r) => r.stats.fix !== 0);
    const alert = $('alert');
    alert.classList.remove('hidden');
    alert.classList.toggle('ok', !bad.length);
    alert.innerHTML = bad.length
        ? `<b>${bad.length} team${bad.length > 1 ? 's' : ''} need a Sleeper FAAB adjustment:</b> ` + bad.map((r) => `${esc(r.displayName)} (${r.stats.fix > 0 ? 'add' : 'remove'} ${money(Math.abs(r.stats.fix))})`).join(', ')
        : 'Every Sleeper balance matches.';

    $('week-rows').innerHTML = bonuses.slice().reverse().map((b) => {
        const list = (arr) => arr.map((s) => `${esc(state.teamName(s.rosterId))} <span class="muted">${s.points.toFixed(2)}</span>`).join(', ');
        return `<tr><td>${b.week}</td><td>${list(b.top)}</td><td>${list(b.low)}</td></tr>`;
    }).join('');
}

function toggle(rid) {
    const row = state.rows.find((r) => r.rosterId === rid);
    if (!row) return;
    row.open = !row.open;
    render();
}

async function loadPlayers() {
    try {
        players = await getJSON('/players/nfl');
        render();
    } catch (e) {
        players = {};
        console.warn('Could not load player names', e);
    }
}

async function main() {
    const leagueId = new URLSearchParams(location.search).get('league') || CONFIG.defaultLeagueId;
    for (const c of document.querySelectorAll('#top-bonus, .top-bonus')) c.textContent = CONFIG.topScorerBonus;
    for (const c of document.querySelectorAll('#low-bonus, .low-bonus')) c.textContent = CONFIG.lowScorerBonus;
    try {
        const [league, nflState, users, rosters] = await Promise.all([
            getJSON(`/league/${leagueId}`), getJSON('/state/nfl'),
            getJSON(`/league/${leagueId}/users`), getJSON(`/league/${leagueId}/rosters`),
        ]);
        if (!league) throw new Error(`League ${leagueId} not found`);
        const budget = league.settings.waiver_budget || 100;
        for (const c of document.querySelectorAll('#cap, .cap')) c.textContent = budget;
        $('league-name').textContent = `${league.name} · ${league.season}`;
        document.title = `FAAB Tracker · ${league.name}`;

        const { weeks, lastTxWeek } = completedWeeks(league, nflState);
        const txWeeks = Array.from({ length: lastTxWeek }, (_, i) => i + 1);
        const [matchups, txs] = await Promise.all([
            Promise.all(weeks.map(async (w) => [w, await getJSON(`/league/${leagueId}/matchups/${w}`) || []])),
            Promise.all(txWeeks.map(async (w) => [w, await getJSON(`/league/${leagueId}/transactions/${w}`) || []])),
        ]);

        const userById = new Map(users.map((u) => [u.user_id, u]));
        const bonuses = weeklyBonuses(matchups);
        const stats = buildLedgers(rosters, txs, bonuses, budget);
        const rows = rosters.map((r) => {
            const user = userById.get(r.owner_id);
            return {
                rosterId: r.roster_id, user,
                displayName: user?.display_name || `Team ${r.roster_id}`,
                teamName: user?.metadata?.team_name || '',
                stats: stats.get(r.roster_id), open: false,
            };
        }).sort((a, b) => (b.stats.fix !== 0) - (a.stats.fix !== 0) || b.stats.real - a.stats.real);

        state = {
            rows, bonuses, budget, weeks,
            teamName: (rid) => rows.find((r) => r.rosterId === rid)?.displayName || `Team ${rid}`,
        };
        $('loading').classList.add('hidden');
        $('results').classList.remove('hidden');
        render();
        $('balance-rows').addEventListener('click', (ev) => {
            const tr = ev.target.closest('tr.team');
            if (tr) toggle(Number(tr.dataset.rid));
        });
        loadPlayers();
    } catch (e) {
        $('loading').classList.add('hidden');
        $('error').classList.remove('hidden');
        $('error').textContent = `Couldn't load league data: ${e.message}`;
    }
}

main();
