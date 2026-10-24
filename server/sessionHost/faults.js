'use strict';

class SimulatedCrash extends Error {
  constructor(point) { super(point); this.name = 'SimulatedCrash'; this.point = point; }
}
const POINTS = Object.freeze(['after_sending_commit', 'after_effect_before_written',
  'after_spawn_before_identity', 'after_decided_commit', 'after_deleting_commit',
  'before_accepted_reply', 'after_control_accept_before_reply',
  'after_spawn_sent_before_spawn', 'after_close_sent']);
function createFaults(points = []) {
  const armed = new Set(points);
  return { arm(point) { armed.add(point); }, hit(point) {
    if (armed.delete(point)) throw new SimulatedCrash(point);
  } };
}
module.exports = { SimulatedCrash, POINTS, createFaults };
