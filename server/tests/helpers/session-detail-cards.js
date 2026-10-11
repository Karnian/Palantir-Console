'use strict';
// Rich-card contracts belong to the timeline renderer after compact rows replace the old list cards.
// This harness composes production SessionCard, snapshot loading, ranking, time and coverage functions.
const vm = require('node:vm');
function installDetailCards(env) {
  vm.runInContext(`
    function DetailCards() {
      const { useEffect, useState } = window.preactHooks;
      const [load, setLoad] = useState({ entries: [], snapshots: [], failures: [], done: 0, total: 0 });
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(false);
      const [query, setQuery] = useState('');
      const [now] = useState(Date.now);
      useEffect(() => {
        const controller = new AbortController();
        loadSessionSnapshots(apiFetch, controller.signal, setLoad).catch(() => {
          if (!controller.signal.aborted) setError(true);
        }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
      }, []);
      const results = rankCards(load.snapshots.flatMap(snapshotCards), query);
      return html\x60<section>
        <div class="work-snapshot-times">\x24{load.entries.filter(entry => entry.machine_id).map(entry => html\x60
          <span class="work-pill"><\x24{SnapshotTime}
            value=\x24{load.snapshots.find(snapshot => snapshot.machine.id === entry.machine_id)?.generated_at
            || entry.generated_at}
            label=\x24{entry.machine_label
              || load.snapshots.find(item => item.machine.id === entry.machine_id)?.machine.label}
            now=\x24{now} snapshot=\x24{true} /></span>\x60)}</div>
        <p class="work-observation-note">\x24{W.observationNote}</p>
        <input id="work-query" value=\x24{query} onInput=\x24{event => setQuery(event.target.value)} />
        <p role="status">\x24{loading ? W.loading(load.done, load.total)
          : W.results(results.length)}</p>
        \x24{error && html\x60<p role="alert">\x24{W.error}</p>\x60}
        \x24{results.map(card => html\x60<\x24{SessionCard} key=\x24{card.key} card=\x24{card}
          query=\x24{query} now=\x24{now} />\x60)}
        <\x24{Coverage} load=\x24{load} />
      </section>\x60;
    }
    this.DetailCards = DetailCards;
  `, env.context);
}
module.exports = { installDetailCards };
