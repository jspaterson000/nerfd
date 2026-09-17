import { DESIGN_CSS, SITE_NAV } from '../assets/design.ts';
import { SHARED_CSS, FAVICON, socialMeta } from './ui.ts';

// The public privacy statement, served at /privacy. Deliberately plain: no
// external assets, no script, no fonts, no trackers. A page that explains why
// nothing is loaded from elsewhere should not load anything from elsewhere.
// Another pass will restyle this to match the site; keep the markup simple.

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const SENT: Array<[string, string]> = [
  ['model, effort level', 'which model answered, and at what reasoning effort'],
  ['tool, tool version', 'which coding agent, and its version. this is the field that separates a model change from a harness change'],
  ['plan tier, price', 'the subscription you told nerfd about, or the one it read off that tool&rsquo;s own config on your machine, so "what did $200 buy" can be answered'],
  ['plan source', 'one word: declared, detected or unknown. which file and field a detector opened stays on your machine; that word and the plan id are the whole of what detection sends'],
  ['ISO week, end time', 'when the session finished'],
  ['task category, size', 'code / debug / refactor / review / ux / strategy / writing / research / ops, inferred from your first prompt on your machine'],
  ['repo language, size bucket, age bucket', 'ts, py, go &hellip; ; small / medium / large by tracked file count; greenfield or established'],
  ['duration', 'how long it ran'],
  ['counts', 'prompts, turns, tool calls, edits, files touched, tests run, errors, rate-limit hits, timeouts, model switches, interrupts, tool-call errors, context-limit hits'],
  ['behavioural signals', 'how much you had to steer: corrections, reprompts, frustration, pushback, clarifications, edits without a prior read, and whether the session was abandoned. counts and rates only, with the detector version next to them. computed on your machine from a transcript already on your disk; the text is dropped before the function returns'],
  ['token totals, latency p50 and p95', 'volume and speed'],
  ['subscription window usage', 'the percentage the tool reports, where it reports one'],
  ['rating, kept', 'your optional 1-5 rating and whether you kept the work. absent unless you typed it'],
  ['survival ratio', 'the share of lines the session added that were still there an hour later. a number, not the lines'],
  ['evidence link', 'empty unless you attached a public gist or PR yourself'],
  ['reporter id', 'a hash of a random number made when you installed. not an account, not derived from anything about you'],
];

const NEVER = [
  'prompt text, or any part of it',
  'model output, or any part of it',
  'source code, diffs, or line contents',
  'file names or paths, absolute or relative',
  'repository names, remotes, branches, or commit hashes',
  'the note you type when you rate a session',
  'your username, hostname, email, git identity, or environment variables',
  'location, advertising ids, or anything from a third-party analytics service',
];

const FAQ: Array<[string, string]> = [
  ['Can my employer see this?',
    'Not through nerfd. There is no admin console, no fleet view, no org enrolment, and no way to look anyone up. Your employer can see your machine and your network the way they always could. Nothing in the record tells them, or anyone, which of their staff sent it.'],
  ['Does it read my code?',
    'It reads your working tree to count lines, and turns each added line into a salted 20-character hash so it can tell later whether that line survived. The hashes stay in the local database. No line, no file name and no hash is ever sent.'],
  ['Does it phone home if sharing is off?',
    'No. One network call exists in the whole CLI, on the sharing path. With sharing off nothing reaches it. Block the endpoint at your proxy and watch nothing break.'],
  ['What about Gemini CLI&rsquo;s telemetry?',
    'Gemini CLI ships its own OpenTelemetry exporter whose common attributes include the user&rsquo;s email address. That is Google&rsquo;s pipeline, under Google&rsquo;s settings, and unrelated to nerfd. When nerfd adds Gemini CLI support it reads the local chat files and deliberately does not touch the OTel stream. Installing nerfd turns no other tool&rsquo;s telemetry on or off.'],
  ['Can I install this without asking legal?',
    'That is the design target. The argument: derived metrics about your own sessions, no content, no identifiers, one endpoint, off with one command, and a collector small enough to read over a coffee. Send your reviewer to the section below.'],
];

const NETWORK: Array<[string, string]> = [
  ['a finished session with sharing on, a manual <code>nerfd share</code>, or a re-rating', 'POST {ORIGIN}/v1/reports &mdash; one JSON body under 2 KB, 6-second timeout, no retry, no cookies, no authentication header'],
  ['install only', 'GET {ORIGIN}/install.sh and GET {ORIGIN}/dist/nerfd.tgz, via curl'],
  ['planned, not yet built', 'a <code>GET /v1/models</code> or <code>/api/show</code> against a <em>local</em> model runtime you configured, to identify a local model. localhost or your own host only, never a third party'],
];

const FILES: Array<[string, string]> = [
  ['~/.nerfd/config.json', 'settings and the random install id, mode 0600'],
  ['~/.nerfd/local.db', 'one row per session'],
  ['~/.nerfd/hook.log', 'hook errors only'],
  ['~/.nerfd/app/**', 'the CLI itself, if installed by curl'],
  ['~/.local/bin/nerfd, ~/.local/bin/ms', 'launchers, if installed by curl'],
  ['~/.claude/settings.json', 'hook entries merged in, with a timestamped backup written first'],
  ['~/.claude/commands/nerfd.md', 'the /nerfd rating command'],
  ['~/.codex/hooks.json', 'hook entries merged in, backed up the same way'],
  ['~/.codex/prompts/nerfd.md', 'the /nerfd rating prompt'],
];

const LOCAL: Array<[string, string]> = [
  ['first prompt', 'the first 300 characters, so the local session list is readable'],
  ['touched files', 'absolute paths of files a session edited, used for the count'],
  ['working directory', 'needed to re-measure code survival later'],
  ['branch and commit', 'recorded at session start'],
  ['your note', 'whatever you typed when you rated the session'],
  ['line hashes', 'salted hashes of added lines, for the survival check'],
  ['transcript path', 'where your tool keeps its own transcript'],
];

const CSS = SHARED_CSS + `
.wrap{max-width:1080px;margin:0 auto;padding:0 32px 64px}
nav{display:flex;align-items:center;gap:24px;min-height:76px;border-bottom:1px solid var(--line);font-size:13px;color:var(--mut);margin-bottom:20px}nav .brand{margin-right:auto;color:var(--fg)}
.page-links{max-width:760px;margin:0 auto 32px;display:flex;gap:20px;color:var(--mut);font-size:12px}
main{max-width:760px;margin:auto;overflow-wrap:anywhere}
h1{font-size:40px;font-weight:600;line-height:1.15;letter-spacing:-1.3px;margin:0 0 16px}
h2{font-size:22px;font-weight:600;margin:42px 0 12px;padding-top:24px;border-top:1px solid var(--line);letter-spacing:-.5px}
h3{font-size:16px;font-weight:600;margin:26px 0 6px}
p{margin:12px 0}.lede{font-size:18px;color:var(--mut);line-height:1.6}small{color:var(--mut);font-size:12px}
ul{padding-left:20px}li{margin:7px 0}
code,pre{font-family:var(--mono);font-size:12px}code{background:var(--soft);padding:2px 5px;border-radius:4px}pre{background:var(--soft);padding:16px;border-radius:10px;border:1px solid var(--line);white-space:pre-wrap;overflow-wrap:anywhere}pre code{background:none;padding:0}
table{margin:18px 0;font-size:13px;table-layout:fixed}th,td{white-space:normal;vertical-align:top;padding:13px 14px}td:first-child{width:34%;font-weight:500}td.w{color:var(--mut)}
footer{margin-top:56px;padding-top:24px;border-top:1px solid var(--line);font-size:12px;color:var(--mut);display:flex;flex-wrap:wrap;gap:10px 20px}
@media(max-width:600px){.wrap{padding:0 20px 40px}nav{gap:14px;min-height:66px;flex-wrap:wrap;padding:16px 0;margin-bottom:32px;font-size:12px}nav .brand{font-size:20px}.page-links{font-size:11px;gap:16px}h1{font-size:33px}h2{font-size:20px}.lede{font-size:16px}table,tbody,tr,td{display:block;width:100%}td:first-child{width:100%;padding:14px 12px 3px;border-bottom:0}td.w{padding:3px 12px 14px}tr{border-bottom:1px solid var(--line)}td{border-bottom:0}tr:has(th){display:none}pre{padding:12px}}
`;

function rows(list: Array<[string, string]>, origin: string): string {
  return list.map(([a, b]) => `<tr><td>${a}</td><td class="w">${b.replace(/\{ORIGIN\}/g, esc(origin))}</td></tr>`).join('\n');
}

export function privacyPage(origin: string): string {
  const o = esc(origin.replace(/\/+$/, ''));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>privacy &middot; nerfd</title>
<meta name="description" content="What nerfd collects, what it never collects, and how to stop it.">
${socialMeta(origin, '/privacy', 'What leaves your machine · nerfd.ai', 'Counts, never conversations. The exact record nerfd sends, what it never sends, and how to stop it.')}
${FAVICON}
<style>${CSS}${DESIGN_CSS}
.wrap{max-width:1280px;padding:0 28px}main{max-width:860px;margin:auto}main h1{font-size:clamp(44px,6vw,70px);line-height:1.1;letter-spacing:-2.5px;font-weight:550;margin:65px 0 22px}main h2{font-weight:550;margin-top:48px}main table{table-layout:fixed}main td{white-space:normal;overflow-wrap:anywhere}main pre{overflow:auto}footer{margin-top:60px}.site-header nav{border:0;min-height:0;padding:0} .site-header{margin:0} @media(max-width:600px){.wrap{padding:0 18px}main h1{margin-top:35px}}
</style>
</head>
<body>
<div class="wrap">

${SITE_NAV}
<div class="page-links"><a href="/export.json">raw data</a><a href="#security">for your security team</a></div>

<main id="main">
<p class="kicker">YOUR DATA / YOUR CHOICE</p><h1>Counts.<br>Never conversations.</h1>
<p class="lede">nerfd measures how a session went, never what it was about.</p>
<p>Prompts, code, file paths, repo names and notes stay on your machine. When sharing is on, one small JSON object per session is sent to one address. Before believing any of that, run <code>nerfd privacy</code>: it prints the exact record, built by the same code that sends it.</p>

<h2>What is sent</h2>
<p>One record per finished session, only while sharing is on. This is the complete list.</p>
<table>${rows(SENT, o)}</table>
<p><small>The shape is defined once, in <code>packages/core/src/types.ts</code>. The conversion from a local session to a public record is a single function, <code>toReport</code> in <code>packages/core/src/redact.ts</code>, short enough to read in a minute. The server rejects anything that does not match.</small></p>

<h2>What is never sent</h2>
<ul>${NEVER.map((x) => `<li>${x}</li>`).join('')}</ul>
<p>Under any setting. There is no flag that turns any of it on. The codebase has zero runtime dependencies, so nothing can add an analytics SDK without it showing up in a diff.</p>

<h2>When it is sent</h2>
<ul>
<li><strong>Never, if sharing is off.</strong> No heartbeat, no version check, no crash report.</li>
<li><strong>After a session ends, if sharing is on.</strong> The hook gives up after six seconds and never blocks or breaks your coding tool.</li>
<li><strong>When you re-rate a session</strong> that was already sent, so the public record matches what you actually think.</li>
<li><strong>When you run <code>nerfd share</code> yourself</strong>, whether or not automatic sharing is on.</li>
</ul>
<p>The one-line installer turns automatic sharing on and prints the field list while it does it. <code>nerfd share off</code> stops it for good.</p>

<h2>See it before it is sent</h2>
<pre><code>nerfd privacy            # status, everything stored locally, and the exact next record
nerfd share --dry-run    # prints the record, sends nothing
nerfd show last --public # the same record
nerfd export --public    # every record you have ever sent</code></pre>

<h2>Stop, and delete</h2>
<pre><code>nerfd share off             # stops all sending, immediately
nerfd init --remove         # takes the hooks back out of your tools
nerfd privacy purge --yes   # deletes the local database and the hook log
rm -rf ~/.nerfd             # removes everything nerfd has ever written</code></pre>
<p>To delete what was already shared: your reporter id is printed by <code>nerfd privacy</code>, and it is the key to every record you sent. A self-serve deletion endpoint is being built; until it ships, send the reporter ids to the contact address and the rows are deleted by hand within seven days. Deletion is real: the rows go and the next aggregate is recomputed without them.</p>

<h2>Stored on your machine</h2>
<p>Everything lives in <code>~/.nerfd</code>, created mode 0700. These fields are kept there because the local scorecard needs them, and are <strong>never</strong> sent:</p>
<table>${rows(LOCAL, o)}</table>
<p><code>nerfd privacy</code> shows the size of each file and how many of each of these it is holding. If your home directory is backed up or synced, treat <code>~/.nerfd/local.db</code> the way you treat your shell history.</p>

<h2>Retention</h2>
<p><strong>On your machine:</strong> until you delete it.</p>
<p><strong>On the server:</strong> raw reports for 13 months, then deleted. Weekly aggregates &mdash; counts, medians and intervals, carrying no reporter id &mdash; are kept indefinitely, because a historical record of how models moved is the entire point. Any access log in front of the application keeps addresses for at most seven days and is never joined to reports.</p>
<p>The server sees the IP address that sent a report, the way every HTTP server does. It is not stored in the reports table, not written to an application log, and not used for anything.</p>

<h2>Fingerprinting, honestly</h2>
<p>A record with no name in it can still be a fingerprint. A rare language, plus an unusual tool build, plus an unusual model id, plus a timestamp to the millisecond, can single out one person. The mitigations, stated so they can be checked:</p>
<ul>
<li><strong>The reporter id rotates weekly.</strong> Derived from the random install id and the ISO week, so records can be deduplicated within a week but not chained across years into a profile. Lasting identity exists only if you choose it, by signing in for a verified badge.</li>
<li><strong>End times are bucketed to the hour, in UTC.</strong> Week-over-week analysis needs the week, not the millisecond, and an hour-of-day pattern gives away a timezone and a working day.</li>
<li><strong>Model ids are matched against a public catalogue.</strong> A custom id such as <code>acme-internal-finetune</code> names an employer, so unrecognised ids are not sent until you allow them.</li>
<li><strong>Tool versions must look like versions</strong>, and repo languages must come from a known list. A wrapped <code>--version</code> banner or a rare in-house file extension is otherwise an identifier.</li>
<li><strong>Plan prices are catalogue prices or nothing.</strong> A free-typed dollar figure is small and sharp.</li>
<li><strong>Small cells are not published.</strong> Fewer than three sessions is unscored; fewer than ten never reaches a public tier.</li>
</ul>

<h2>Governance</h2>
<ul>
<li><strong>No money from model labs. Ever.</strong> Not sponsorship, not a data deal, not a grant. Every evaluator that took lab money stopped being worth reading.</li>
<li><strong>The collector is open source.</strong> The code that decides what leaves your machine is about forty lines with no dependencies. Read it instead of trusting this page.</li>
<li><strong>The scoring formula is published</strong> in the board footer, so a number you disagree with can be argued with.</li>
<li><strong>Open data, CC BY 4.0.</strong> The tier board, drift tables, weekly summaries and the JSON behind them are yours to use, chart and quote; just say where they came from. Raw per-session rows are published under the same licence once the fingerprinting mitigations above are all shipped &mdash; until then this site serves aggregates only.</li>
</ul>

<h2>Questions people at companies ask</h2>
${FAQ.map(([q, a]) => `<h3>${q}</h3><p>${a}</p>`).join('\n')}

<h2 id="security">For your security team</h2>
<h3>Every network call the CLI makes</h3>
<table><tr><th>when</th><th>call</th></tr>${rows(NETWORK, o)}</table>
<p>Nothing else. No version check, no crash reporting, no telemetry, no CDN, no web fonts. This page and the board load no external assets.</p>
<h3>Every process it spawns</h3>
<p><code>git</code> (rev-parse, ls-files, log, rev-list, diff) inside your project directory, and <code>claude --version</code> / <code>codex --version</code>. All with a timeout, all with stderr discarded.</p>
<h3>Every file it writes</h3>
<table>${rows(FILES, o)}</table>
<p>It writes nothing inside your repository, and never writes to your tool&rsquo;s transcript files.</p>
<h3>What the server stores</h3>
<p>One append-only table: the JSON described at the top, plus the time it arrived. No IP column, no user-agent column, no account table, no cookies, and no third-party script on any page.</p>

</main>
<footer>
  <span>open collector, open data, open formula</span>
  <a href="/">home</a>
  <a href="/board">board</a>
  <a href="/export.json">raw data</a>
  <span>no money from model labs, ever</span>
</footer>

</div>
</body>
</html>
`;
}
