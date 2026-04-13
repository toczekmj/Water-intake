import assert from "node:assert/strict";
import test from "node:test";
import { computeHydrationForEntry, getCaffeinePenaltyPct } from "./hydration.js";

test("applies occasional caffeine penalty after threshold", () => {
  const penalty = getCaffeinePenaltyPct("occasional", 210, 80);
  assert.equal(penalty, 10);
});

test("does not apply caffeine penalty to decaf entries", () => {
  const penalty = getCaffeinePenaltyPct("rare", 500, 0);
  assert.equal(penalty, 0);
});

test("computes hydration and electrolyte snapshots", () => {
  const result = computeHydrationForEntry({
    volumeMl: 500,
    defaultHydrationFactor: 0.9,
    caffeineMgPer100ml: 40,
    sodiumMgPer100ml: 20,
    potassiumMgPer100ml: 10,
    magnesiumMgPer100ml: 4,
    useHydrationFactors: true,
    caffeineHabituation: "regular",
    dailyCaffeineBeforeMg: 390
  });

  assert.equal(result.caffeineMg, 200);
  assert.equal(result.appliedCaffeinePenaltyPct, 10);
  assert.equal(result.creditedHydrationMl, 405);
  assert.equal(result.sodiumMg, 100);
  assert.equal(result.potassiumMg, 50);
  assert.equal(result.magnesiumMg, 20);
});

test("disables hydration factor when user setting is off", () => {
  const result = computeHydrationForEntry({
    volumeMl: 300,
    defaultHydrationFactor: 0.4,
    caffeineMgPer100ml: null,
    sodiumMgPer100ml: 0,
    potassiumMgPer100ml: 0,
    magnesiumMgPer100ml: 0,
    useHydrationFactors: false,
    caffeineHabituation: "regular",
    dailyCaffeineBeforeMg: 0
  });

  assert.equal(result.appliedHydrationFactor, 1);
  assert.equal(result.creditedHydrationMl, 300);
});
