// Standalone structural verifier; executable both as a file and as `node -` over SSH.
async function main() {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const crypto = await import('node:crypto');
  const checks = [];
  let inspect = false;
  const features = { queued: false, end_turn_resumed: false, interrupted: false };
  const finish = () => process.stdout.write(JSON.stringify({ ok: checks.length > 0 && checks.every(c => c.ok), checks,
    ...(inspect ? { features } : {}) }) + '\n');
  const INTERRUPTION_MARKER = /^\[Request interrupted by user(?: for tool use)?\]$/;
  function interruptionInContent(content) {
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(block => block?.type === 'text').map(block => block.text).join('') : '';
    // A quoted marker in one block does not interrupt an otherwise human request.
    return INTERRUPTION_MARKER.test(text);
  }
  const CLAUDE_OUTPUT_PREFIX = /^<(task-notification|local-command-stdout|local-command-caveat|bash-stdout|bash-stderr)>/;
  const SLASH_INPUT_PREFIX = /^<(command-name|command-message)>/;
  const SHELL_INPUT_PREFIX = '<bash-input>';
  const NON_USER_ORIGINS = ['task_notification', 'scheduled'];
  const HUMAN_PROMPT_SOURCES = ['typed', 'queued', 'suggestion_accepted'];
  const CODEX_INJECTED_PREFIX = /^(<environment_context>|<codex_internal_context>|# AGENTS.md instructions)/;
  const REPLY_INPUT_PREFIX = '<send_user_message_question_reply>';
  const UNKNOWN_TAG_PREFIX = /^<[^>]+>/;
  function claudeText(content) {
    return typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n\n') : '';
  }
  // Independent i0a §1.1 decision table, in exclusion-first order. A queued
  // attachment is an instruction, but never starts a separate execution interval.
  function claudeInstructionKind(record) {
    let content, origin;
    if (record.type === 'attachment' && record.attachment?.type === 'queued_command') {
      const queued = record.attachment;
      if (queued.origin?.kind !== 'human' || queued.humanTurn === false || queued.commandMode !== 'prompt'
        || typeof queued.prompt !== 'string') return null;
      content = queued.prompt; origin = queued.origin;
    } else {
      if (record.type !== 'user') return null;
      content = record.message?.content; origin = record.origin;
    }
    if (Array.isArray(content) && content.length && content.every(block => block?.type === 'tool_result')) return null;
    if (record.isMeta || record.isCompactSummary || record.isSidechain) return null;
    const text = claudeText(content);
    if (CLAUDE_OUTPUT_PREFIX.test(text) || NON_USER_ORIGINS.includes(record.turnOrigin) || record.promptSource === 'system') return null;
    // Conflicting explicit provenance wins over wrappers and human-source hints.
    if (origin?.kind !== undefined && origin.kind !== 'human') return null;
    if (SLASH_INPUT_PREFIX.test(text) && origin === undefined) return 'slash';
    if (text.startsWith(SHELL_INPUT_PREFIX)) return 'shell';
    if (origin?.kind === 'human' || record.turnOrigin === 'human' || HUMAN_PROMPT_SOURCES.includes(record.promptSource)) return 'human';
    return null;
  }
  function codexInstructionKind(payload) {
    if (!Array.isArray(payload.content)) return null;
    let supported = false, reply = false;
    for (const block of payload.content) {
      if (block?.type === 'input_image') { supported = true; continue; }
      if (block?.type !== 'input_text' || typeof block.text !== 'string' || CODEX_INJECTED_PREFIX.test(block.text)) continue;
      if (block.text.startsWith(REPLY_INPUT_PREFIX)) { supported = true; reply = true; }
      else if (!UNKNOWN_TAG_PREFIX.test(block.text)) supported = true;
    }
    return supported ? reply ? 'reply' : 'human' : null;
  }
  const STATUSES = ['final', 'no_text', 'pending', 'interrupted', 'local_command', 'queued_joined', 'unbound', 'withheld', 'target_changed', 'unavailable'];
  const check = (name, ok) => { checks.push({ name, ok: Boolean(ok) }); return Boolean(ok); };
  try {
    const args = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      if (process.argv[i] === '--inspect') { inspect = true; i--; continue; }
      if (!/^--(?:provider|instr-id|file-fp|evidence-ids|segment|home-dir|status|reason)$/.test(process.argv[i]) || process.argv[i + 1] === undefined) throw Error();
      args[process.argv[i].slice(2).replaceAll('-', '_')] = process.argv[i + 1];
    }
    const env = process.env;
    const input = env.ANSWER_AUDIT_INPUT ? JSON.parse(env.ANSWER_AUDIT_INPUT) : {};
    inspect ||= input.inspect === true;
    for (const name of ['provider', 'instrId', 'file_fp', 'evidence_ids', 'segment', 'homeDir', 'expected_status', 'expected_reason']) {
      const snake = name === 'expected_reason' ? 'reason' : name === 'expected_status' ? 'status' : name === 'instrId' ? 'instr_id' : name === 'homeDir' ? 'home_dir' : name;
      const value = args[snake] ?? env['ANSWER_AUDIT_' + snake.toUpperCase()];
      if (value !== undefined) input[name] = ['evidence_ids', 'segment'].includes(name) ? JSON.parse(value) : value;
    }
    const id = /^(claude|codex):([A-Za-z0-9_-]{1,64}):([uin][A-Za-z0-9_-]{1,64})$/.exec(input.instrId);
    if (!check('input', id && input.provider === id[1] && /^[0-9a-f]{16}$/.test(input.file_fp)
      && Array.isArray(input.evidence_ids) && input.evidence_ids.length <= 100000
      && input.evidence_ids.every(v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v))
      && (input.expected_status === undefined || STATUSES.includes(input.expected_status))
      && (input.expected_reason == null || ['branch_conflict', 'chain_broken', 'segment_conflict', 'unsupported_format'].includes(input.expected_reason))
      && input.segment && ['start_id', 'end_id'].every(k => input.segment[k] === null
        || typeof input.segment[k] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(input.segment[k])))) throw Error();
    const home = input.homeDir ?? os.homedir();
    const root = path.join(home, input.provider === 'claude' ? '.claude/projects' : '.codex/sessions');
    const files = []; let entries = 0;
    function walk(dir, depth = 0) {
      if (depth > 32) throw Error();
      let stat;
      try { stat = fs.lstatSync(dir); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
      if (stat.isSymbolicLink() || !stat.isDirectory()) return;
      for (const name of fs.readdirSync(dir).sort()) {
        if (++entries > 10000) throw Error();
        const file = path.join(dir, name), s = fs.lstatSync(file, { bigint: true });
        if (s.isSymbolicLink()) continue;
        if (s.isDirectory()) walk(file, depth + 1);
        else if (s.isFile() && name.endsWith('.jsonl')) {
          const fp = crypto.createHash('sha256').update(`palantir-file/1:${s.dev}:${s.ino}`).digest('hex').slice(0, 16);
          if (fp === input.file_fp) files.push({ file, s });
        }
      }
    }
    walk(root);
    if (!check('file_unique', files.length === 1)) throw Error();
    const fd = fs.openSync(files[0].file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const rows = []; let selected, userNo = 0, toolIdentifiers = 0;
    try {
      const initial = fs.fstatSync(fd, { bigint: true });
      if (initial.dev !== files[0].s.dev || initial.ino !== files[0].s.ino || initial.size > 256n * 1024n * 1024n) throw Error();
      function consume(line, terminated = true) {
        if (!line.trim()) return;
        let r; try { r = JSON.parse(line); } catch { if (!terminated) return; throw Error(); }
        if (!r || typeof r !== 'object' || Array.isArray(r)) throw Error();
        if (selected === undefined) {
          if (input.provider === 'claude' && typeof r.sessionId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(r.sessionId)) selected = r.sessionId;
          if (input.provider === 'codex' && r.type === 'session_meta') selected = r.payload?.id;
        }
        if (input.provider === 'claude') {
          if (r.isSidechain === true) return;
          const hidden = r.isMeta === true || r.isCompactSummary === true;
          const c = r.message?.content;
          const text = claudeText(c);
          const interrupted = !hidden && r.type === 'user' && interruptionInContent(c);
          const kind = claudeInstructionKind(r);
          const startsExecution = r.type === 'user' && !interrupted && kind !== null;
          const toolResult = !hidden && r.type === 'user' && Array.isArray(c) && c.some(b => b?.type === 'tool_result');
          const stdout = r.type === 'user' ? c : r.type === 'system' && r.subtype === 'local_command' ? r.content : null;
          rows.push({ type: r.type, id: r.uuid, parent: r.parentUuid, kind, startsExecution, interrupted, toolResult,
            transparent: hidden || r.type === 'attachment', command: SLASH_INPUT_PREFIX.test(text),
            localStdout: !hidden && typeof stdout === 'string' && stdout.startsWith('<local-command-stdout>'),
            queued: r.type === 'attachment' && r.attachment?.type === 'queued_command' && kind !== null,
            stop: r.message?.stop_reason, messageId: r.message?.id,
            calls: r.type === 'assistant' && Array.isArray(c) ? c.filter(b => b?.type === 'tool_use')
              .map(b => typeof b.id === 'string' ? b.id : null) : [],
            results: r.type === 'user' && Array.isArray(c) ? c.filter(b => b?.type === 'tool_result')
              .map(b => typeof b.tool_use_id === 'string' ? b.tool_use_id : null) : [] });
        } else {
          const p = r.payload ?? {};
          const rawUser = r.type === 'response_item' && p.type === 'message' && p.role === 'user';
          if (rawUser) userNo++; // Ordinals count every raw user message, including injected-only ones.
          const kind = rawUser ? codexInstructionKind(p) : null;
          rows.push({ type: r.type, event: p.type, turn: p.turn_id, kind,
            instruction: kind !== null ? `codex:${id[2]}:${p.id === undefined ? 'n' + userNo : 'i' + p.id}` : null,
            role: p.role, phase: p.phase });
        }
        toolIdentifiers += (rows.at(-1)?.calls?.length || 0) + (rows.at(-1)?.results?.length || 0);
        if (rows.length + toolIdentifiers > 100000) throw Error();
      }
      const buffer = Buffer.alloc(256 * 1024); let offset = 0, pending = Buffer.alloc(0);
      while (offset < Number(initial.size)) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, Number(initial.size) - offset), offset);
        if (!count) throw Error(); offset += count;
        const data = Buffer.concat([pending, buffer.subarray(0, count)]); let start = 0, end;
        while ((end = data.indexOf(10, start)) !== -1) {
          if (end - start > 8 * 1024 * 1024) throw Error(); consume(data.toString('utf8', start, end)); start = end + 1;
        }
        pending = Buffer.from(data.subarray(start)); if (pending.length > 8 * 1024 * 1024) throw Error();
      }
      if (pending.length) consume(pending.toString('utf8'), false);
      const final = fs.fstatSync(fd, { bigint: true }), named = fs.statSync(files[0].file, { bigint: true });
      if (!check('stable_file', final.dev === initial.dev && final.ino === initial.ino && final.size >= initial.size
        && named.dev === initial.dev && named.ino === initial.ino)) throw Error();
    } finally { fs.closeSync(fd); }
    if (!check('session_identity', selected === id[2])) throw Error();
    if (input.provider === 'claude') {
      const byId = new Map(rows.filter(r => typeof r.id === 'string').map(r => [r.id, r]));
      const target = byId.get(id[3].slice(1));
      if (!check('instruction', target && (inspect ? true : target.queued ? target.startsExecution || target.queued
        : target.startsExecution && input.segment.start_id === target.id))) throw Error();
      if (inspect && target.queued) { features.queued = true; finish(); return; }
      // Snapshot unknown entries can name interruption markers or injected users.
      // They are readable records, but do not start their own execution interval.
      if (inspect && !target.startsExecution) { finish(); return; }
      if (target.queued && !inspect) {
        check('claim_status', input.expected_status === undefined || input.expected_status === 'queued_joined');
        check('queued_has_no_own_execution', input.evidence_ids.length === 0 && input.segment.start_id === null && input.segment.end_id === null);
        checks.push({ name: 'no_resume', ok: true });
        finish(); return;
      }
      const index = rows.indexOf(target);
      const membership = new Map(rows.filter(r => r.startsExecution).map(r => [r, 'outside']));
      membership.set(target, 'within');
      function locate(row) {
        const path = [], seen = new Set(); let cursor = row, outcome;
        while (cursor && !membership.has(cursor)) {
          if (seen.has(cursor)) { outcome = 'loop'; break; }
          path.push(cursor); seen.add(cursor);
          if (cursor.parent === null) { outcome = 'outside'; break; }
          if (typeof cursor.parent !== 'string') { outcome = 'invalid'; break; }
          if (!byId.has(cursor.parent)) { outcome = 'lost'; break; }
          cursor = byId.get(cursor.parent);
        }
        outcome ||= membership.get(cursor) || 'outside';
        for (const node of path) membership.set(node, outcome);
        return outcome;
      }
      const candidates = rows.filter((r, i) => i > index
        && !r.transparent && ['user', 'assistant', 'system'].includes(r.type));
      const broken = byId.size !== rows.filter(r => typeof r.id === 'string').length
        || candidates.some(r => ['lost', 'loop', 'invalid'].includes(locate(r)));
      const segment = rows.filter(r => locate(r) === 'within');
      const significant = segment.filter(r => !r.transparent && ['user', 'assistant', 'system'].includes(r.type));
      function visibleParent(row) {
        let parent = byId.get(row.parent); const seen = new Set();
        while (parent?.transparent && !seen.has(parent)) { seen.add(parent); parent = byId.get(parent.parent); }
        return parent;
      }
      if (inspect) {
        // Classification proves feature presence, without making an answer claim.
        // Track actual ancestor end_turn records, so siblings cannot imply resume.
        const positions = new Map(rows.map((record, i) => [record, i]));
        const firstEnds = new Map([[target, Infinity]]);
        function earliestEnd(record) {
          const trail = []; let cursor = record;
          while (cursor && locate(cursor) === 'within' && !firstEnds.has(cursor)) {
            trail.push(cursor); cursor = visibleParent(cursor);
          }
          let earliest = firstEnds.get(cursor) ?? Infinity;
          for (const entry of trail.reverse()) {
            if (!entry.transparent && entry.type === 'assistant' && entry.stop === 'end_turn')
              earliest = Math.min(earliest, positions.get(entry));
            firstEnds.set(entry, earliest);
          }
          return earliest;
        }
        for (const record of significant) {
          features.interrupted ||= record.interrupted;
          const resumes = record.toolResult || record.type === 'assistant' && [null, 'tool_use'].includes(record.stop);
          if (resumes && earliestEnd(visibleParent(record)) < positions.get(record)) features.end_turn_resumed = true;
        }
        finish(); return;
      }
      // Independent message graph: UUIDs still establish membership, while each
      // assistant message contributes one vertex with the union of its call IDs.
      const vertices = [], messageVertices = new Map(), vertexFor = new Map(), firstBlocks = new Map();
      function firstBlock(record) {
        const traversed = []; let cursor = record;
        while (!firstBlocks.has(cursor)) {
          traversed.push(cursor);
          const preceding = visibleParent(cursor);
          if (preceding?.type !== 'assistant' || preceding.messageId !== record.messageId) break;
          cursor = preceding;
        }
        const first = firstBlocks.get(cursor) || cursor;
        for (const entry of traversed) firstBlocks.set(entry, first);
        return first;
      }
      for (const r of significant) {
        const message = r.type === 'assistant' && typeof r.messageId === 'string' && r.messageId && firstBlock(r);
        let vertex = message && messageVertices.get(message);
        if (!vertex) {
          vertex = { records: [], incoming: new Set(), outgoing: new Set(), calls: new Set() };
          vertices.push(vertex); if (message) messageVertices.set(message, vertex);
        }
        vertex.records.push(r); vertexFor.set(r, vertex);
        for (const call of r.calls) vertex.calls.add(call);
      }
      for (const r of significant.filter(r => r !== target)) {
        const vertex = vertexFor.get(r), parent = vertexFor.get(visibleParent(r));
        if (parent && parent !== vertex) { vertex.incoming.add(parent); parent.outgoing.add(vertex); }
      }
      for (const r of rows.filter(r => r.startsExecution && r !== target)) {
        if (locate(visibleParent(r)) === 'within') vertexFor.get(visibleParent(r))?.outgoing.add(r);
      }
      function terminalOutput(vertex) {
        if (!vertex.records) return false;
        const r = vertex.records[0], parent = [...vertex.incoming][0];
        return vertex.records.length === 1 && vertex.incoming.size === 1 && r.toolResult && !r.startsExecution
          && r.results.length > 0 && parent.records[0].type === 'assistant'
          && r.results.every(id => typeof id === 'string' && id.length > 0 && parent.calls.has(id));
      }
      const satellites = new Set(vertices.filter(v => v.outgoing.size === 0 && terminalOutput(v)));
      const rootVertex = vertexFor.get(target);
      function ancestors(endpoint) {
        const chain = new Set(); let vertex = endpoint;
        while (vertex && !chain.has(vertex)) {
          chain.add(vertex);
          if (vertex === rootVertex) return chain;
          if (vertex.incoming.size !== 1) return null;
          vertex = [...vertex.incoming][0];
        }
        return null;
      }
      const primary = [vertexFor.get(significant.at(-1)), vertices.filter(v => !satellites.has(v)).at(-1)]
        .map(ancestors).find(chain => chain && vertices.every(v => chain.has(v) || satellites.has(v)));
      const siblingFork = vertices.some(v => {
        const descendants = [...v.outgoing], ordinary = descendants.filter(child => !terminalOutput(child));
        return ordinary.length > 1 || descendants.length > 1 && ordinary.some(child =>
          child.records?.[0]?.toolResult && !child.records[0].startsExecution);
      });
      const forks = siblingFork || !primary || vertices.some(v => v !== rootVertex && v.incoming.size !== 1);
      if (!inspect && input.expected_status === 'unbound') {
        const reason = input.expected_reason;
        const missing = candidates.some(r => locate(r) === 'lost');
        const cyclic = candidates.some(r => locate(r) === 'loop');
        const duplicate = byId.size !== rows.filter(r => typeof r.id === 'string').length;
        check('unbound_reason', reason === 'branch_conflict' ? !missing && (forks || cyclic || duplicate)
          : reason === 'chain_broken' ? missing : false);
        check('unbound_diag', input.evidence_ids.length === 0 && input.segment.end_id === null);
        finish(); return;
      }
      check('chain_and_branches', !broken && !forks);
      const mainRows = primary ? significant.filter(r => primary.has(vertexFor.get(r))) : significant;
      const evidence = input.evidence_ids.map(value => byId.get(value));
      check('segment_end', input.segment.end_id === mainRows.at(-1)?.id);
      if (evidence.length === 0) {
        const last = mainRows.filter(r => r.interrupted || r.toolResult || r.type === 'assistant'
          || target.command && r.localStdout).at(-1);
        const unfinished = !last || last.toolResult || last.type === 'assistant' && [null, 'tool_use'].includes(last.stop);
        const local = target.command && last?.localStdout;
        check('nonterminal_segment', unfinished || local);
        check('claim_status', input.expected_status === undefined || input.expected_status === (local ? 'local_command' : 'pending'));
        checks.push({ name: 'no_resume', ok: true });
      } else {
        const mainIndex = new Map(mainRows.map((r, i) => [r, i]));
        check('evidence_in_segment', evidence.every(r => mainIndex.has(r)));
        const lastEvidenceIndex = evidence.reduce((last, r) => Math.max(last, mainIndex.get(r) ?? -1), -1);
        const terminal = evidence.at(-1);
        check('claim_status', input.expected_status === undefined || (terminal?.interrupted
          ? input.expected_status === 'interrupted' : ['final', 'no_text'].includes(input.expected_status)));
        check('terminal_evidence', terminal && (terminal.interrupted && evidence.length === 1
          || terminal.type === 'assistant' && terminal.stop === 'end_turn'
          && evidence.every(r => r?.type === 'assistant' && r.stop !== 'tool_use')));
        check('no_resume', lastEvidenceIndex >= 0 && !mainRows.slice(lastEvidenceIndex + 1)
          .some(r => r.interrupted || r.toolResult || r.type === 'assistant' || target.command && r.localStdout));
        if (terminal?.messageId) check('same_message_group', evidence.every(r => r.messageId === terminal.messageId));
      }
    } else {
      const index = rows.findIndex(r => r.instruction === input.instrId);
      let start = -1;
      for (let i = 0; i < index; i++) if (rows[i].type === 'event_msg' && rows[i].event === 'task_started') start = i;
      const nextStart = rows.findIndex((r, i) => i > start && r.type === 'event_msg' && r.event === 'task_started');
      const end = nextStart < 0 ? rows.length : nextStart;
      const segment = rows.slice(Math.max(0, start), end), turn = rows[start]?.turn ?? null;
      if (inspect) {
        if (!check('instruction', index >= 0)) throw Error();
        features.interrupted = start >= 0 && segment.some(record => record.type === 'event_msg'
          && record.event === 'turn_aborted' && record.turn === turn);
        finish(); return;
      }
      const endings = segment.filter(r => r.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(r.event));
      const closingIndex = rows.findIndex((r, i) => i > start && r.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(r.event));
      const open = endings.length === 0;
      const crossed = segment.some(r => (r.type === 'turn_context' || r.type === 'event_msg'
        && (r.event?.startsWith('task_') || r.event === 'turn_aborted')) && r.turn !== turn)
        || nextStart >= 0 && rows.slice(nextStart).some(r => r.turn === turn);
      const conflict = start < 0 || index <= start || index >= end || open && nextStart >= 0
        || endings.length > 1 || !open && closingIndex < index || crossed
        || !open && rows.slice(closingIndex + 1, end).some(r => r.role === 'assistant' || r.role === 'user');
      if (input.expected_status === 'unbound') {
        check('instruction_in_segment', index >= 0);
        check('unbound_reason', input.expected_reason === 'segment_conflict' && conflict);
        check('unbound_diag', input.segment.start_id === turn && input.segment.end_id === null && input.evidence_ids.length === 0);
        finish(); return;
      }
      check('instruction_in_segment', index > start && start >= 0 && (closingIndex < 0 || index < closingIndex));
      check('turn_id', Boolean(turn) && input.segment.start_id === turn && input.segment.end_id === (open ? null : turn)
        && (open ? input.evidence_ids.length === 0 : input.evidence_ids.length > 0 && input.evidence_ids.every(v => v === turn)));
      check('closed_without_conflict', !conflict);
      check('claim_status', input.expected_status === undefined || (open ? input.expected_status === 'pending'
        : endings[0]?.event === 'turn_aborted' ? input.expected_status === 'interrupted' : ['final', 'no_text'].includes(input.expected_status)));
      if (open) {
        const assistants = segment.filter(r => r.role === 'assistant');
        check('supported_format', !assistants.length || assistants.some(r => ['commentary', 'final_answer'].includes(r.phase)));
      }
      check('no_resume', open || closingIndex >= 0 && !rows.slice(closingIndex + 1, end).some(r => r.role === 'assistant' || r.role === 'user'));
    }
  } catch { check('audit_complete', false); }
  finish();
}
main().catch(() => { process.stdout.write('{"ok":false,"checks":[{"name":"execution","ok":false}]}\n'); process.exitCode = 1; });
