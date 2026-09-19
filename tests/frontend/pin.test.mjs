// Corner snapping for alignment pins (sextant-map.js snapToVertex). Run: node --test tests/frontend
import { test } from "node:test";
import assert from "node:assert/strict";
import { snapToVertex } from "../../custom_components/sextant/frontend/sextant-map.js";

const rect = (x0, y0, x1, y1) => ({ cords: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] });
const rooms = [rect(0, 0, 400, 300), rect(400, 0, 800, 300)];

test("a pin dropped near a room corner lands exactly on it", () => {
  assert.deepEqual(snapToVertex({ x: 797, y: 296 }, rooms, 12), { x: 800, y: 300 });
});

test("out of reach of every corner the pin stays where it was put", () => {
  assert.equal(snapToVertex({ x: 200, y: 150 }, rooms, 12), null);
  assert.equal(snapToVertex({ x: 413, y: 0 }, rooms, 12), null);   // on a wall, but 13 px from its corner
});

test("the nearest corner wins, and a corner two rooms share is one corner", () => {
  assert.deepEqual(snapToVertex({ x: 405, y: 4 }, rooms, 12), { x: 400, y: 0 });
  assert.deepEqual(snapToVertex({ x: 9, y: 2 }, [rect(0, 0, 10, 10), rect(16, 0, 30, 10)], 12), { x: 10, y: 0 });
});

test("a floor with no rooms, or rooms with no points, snaps to nothing", () => {
  assert.equal(snapToVertex({ x: 1, y: 1 }, [], 12), null);
  assert.equal(snapToVertex({ x: 1, y: 1 }, undefined, 12), null);
  assert.equal(snapToVertex({ x: 1, y: 1 }, [{}], 12), null);
});

// --- ghosts (staleness) and the short age label -------------------------------------
import { staleness, shortAge } from "../../custom_components/sextant/frontend/sextant-map.js";

test("a thing is a ghost only once it has gone unheard longer than the threshold", () => {
  const now = 10_000;
  assert.equal(staleness({ updated: now - 119 }, 120, now).ghost, false);
  assert.equal(staleness({ updated: now - 121 }, 120, now).ghost, true);
  assert.equal(staleness({ updated: now - 121 }, 120, now).age, 121);
  assert.equal(staleness({ updated: now - 9999 }, 0, now).ghost, false);   // 0 switches ghosts off
  assert.equal(staleness({}, 120, now).ghost, false);                      // a replayed history point has no age
});

test("ages read as the shortest honest phrase", () => {
  assert.deepEqual([45, 180, 7300, 200000].map(shortAge), ["45s", "3m", "2h", "2d"]);
});
