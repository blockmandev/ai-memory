#!/usr/bin/env node
// ============================================================
// test-memory.js — Full test of the memory engine
// Saves DB in same folder: ./test-memories.db
// ============================================================

import { MemoryEngine } from './memory-engine.js';
import { existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';

const DB_PATH = resolve('./test-memories.db');
let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  [PASS] ${name}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${name}`);
    failed++;
  }
}

// Clean up old test DB
if (existsSync(DB_PATH)) unlinkSync(DB_PATH);

console.log('===========================================');
console.log(' Memory Engine v2.0 — Full Test Suite');
console.log(`  DB: ${DB_PATH}`);
console.log('===========================================\n');

const engine = new MemoryEngine({ dbPath: DB_PATH });

// ---- TEST 1: Add memories with types & importance ----
console.log('TEST 1: Add memories');
const mem1 = await engine.add({
  content: 'User name is Alex, lives in London',
  containerTags: ['user_123'],
  memoryType: 'static',
  importance: 'critical',
});
assert(mem1.id, 'Static memory added with ID: ' + mem1.id);
assert(mem1.importance === 'critical', 'Importance set to critical');

const mem2 = await engine.add({
  content: 'User prefers dark mode and codes in Python',
  containerTags: ['user_123'],
  memoryType: 'static',
  importance: 'high',
});
assert(mem2.id, 'Second static memory added');

const mem3 = await engine.add({
  content: 'Working on QoraNet blockchain project with IPFS storage',
  containerTags: ['user_123', 'project_qoranet'],
  memoryType: 'dynamic',
  importance: 'normal',
});
assert(mem3.id, 'Dynamic memory with multi-tag added');

const mem4 = await engine.add({
  content: 'Had a meeting about consensus algorithm design yesterday',
  containerTags: ['user_123'],
  memoryType: 'episodic',
  importance: 'normal',
});
assert(mem4.id, 'Episodic memory added');

const mem5 = await engine.add({
  content: 'User likes sushi and Italian food',
  containerTags: ['user_123'],
  memoryType: 'static',
  importance: 'normal',
});
assert(mem5.id, 'Food preference memory added');

console.log('');

// ---- TEST 2: Search memories ----
console.log('TEST 2: Search memories');
const search1 = await engine.search({
  q: 'blockchain project',
  containerTags: ['user_123'],
  limit: 5,
});
assert(search1.results.length > 0, `Found ${search1.results.length} results for "blockchain project"`);
assert(search1.results[0].content.includes('QoraNet'), 'Top result contains QoraNet');

const search2 = await engine.search({
  q: 'dark mode Python',
  containerTags: ['user_123'],
  limit: 3,
});
assert(search2.results.length > 0, `Found ${search2.results.length} results for "dark mode Python"`);

// Search with type filter
const search3 = await engine.search({
  q: 'user',
  containerTags: ['user_123'],
  memoryTypes: ['static'],
  limit: 10,
});
assert(search3.results.every(r => r.memoryType === 'static'), 'Type filter works — all results are static');

// Search with importance filter
const search4 = await engine.search({
  q: 'user',
  containerTags: ['user_123'],
  minImportance: 'high',
  limit: 10,
});
const highOrAbove = search4.results.every(r => r.importance === 'critical' || r.importance === 'high');
assert(highOrAbove, 'Importance filter works — only high/critical returned');

console.log('');

// ---- TEST 3: Multi-tag search ----
console.log('TEST 3: Multi-tag support');
const tagSearch = await engine.search({
  q: 'QoraNet',
  containerTags: ['project_qoranet'],
  limit: 5,
});
assert(tagSearch.results.length > 0, `Found via project_qoranet tag: ${tagSearch.results.length} result(s)`);
assert(tagSearch.results[0].tags.includes('project_qoranet'), 'Result has project_qoranet tag');
assert(tagSearch.results[0].tags.includes('user_123'), 'Result also has user_123 tag (multi-tag!)');

console.log('');

// ---- TEST 4: Update memory ----
console.log('TEST 4: Update memory');
const updateResult = await engine.update(mem3.id, {
  content: 'Working on QoraNet v2 — new consensus algorithm with BFT',
  importance: 'high',
});
assert(updateResult.success, 'Memory updated successfully');

const updated = await engine.search({ q: 'QoraNet v2 BFT', containerTags: ['user_123'], limit: 1 });
assert(updated.results.length > 0 && updated.results[0].content.includes('BFT'), 'Updated content is searchable');

console.log('');

// ---- TEST 5: Memory relationships ----
console.log('TEST 5: Memory relationships (graph)');
engine.link(mem1.id, mem2.id, 'related', 0.9);
engine.link(mem1.id, mem5.id, 'related', 0.7);
engine.link(mem3.id, mem4.id, 'context', 0.8);

const related = engine.getRelated(mem1.id);
assert(related.length === 2, `Found ${related.length} related memories for mem1`);
assert(related[0].relation === 'related', 'Relation type is correct');

const projectRelated = engine.getRelated(mem3.id, { relation: 'context' });
assert(projectRelated.length === 1, 'Context relation found for project memory');

console.log('');

// ---- TEST 6: User profile ----
console.log('TEST 6: Get user profile');
const profile = await engine.getProfile('user_123', 'what project');
assert(profile.profile.static.length >= 3, `Profile has ${profile.profile.static.length} static memories`);
assert(profile.profile.dynamic.length >= 1, `Profile has ${profile.profile.dynamic.length} dynamic memories`);
assert(profile.stats.total >= 5, `Stats show ${profile.stats.total} total memories`);
assert(profile.profile.static[0].importance === 'critical', 'Critical memories come first in profile');

console.log('');

// ---- TEST 7: Conversations ----
console.log('TEST 7: Save conversation');
const conv = await engine.addConversation({
  conversationId: 'test_conv_001',
  messages: [
    { role: 'user', content: 'Help me with my blockchain project' },
    { role: 'assistant', content: 'Sure! What aspect of QoraNet do you need help with?' },
    { role: 'user', content: 'The consensus module needs BFT support' },
    { role: 'assistant', content: 'I can help design a BFT consensus module.' },
  ],
  containerTags: ['user_123'],
  extractFacts: false, // no LLM available for extraction in test
});
assert(conv.conversationId === 'test_conv_001', 'Conversation saved');

// Conversation should be searchable as episodic memory
const convSearch = await engine.search({ q: 'BFT consensus module', containerTags: ['user_123'], limit: 3 });
assert(convSearch.results.length > 0, 'Conversation is searchable');

console.log('');

// ---- TEST 8: Soft delete + restore ----
console.log('TEST 8: Soft delete & restore');
engine.delete(mem5.id);
const afterDelete = await engine.search({ q: 'sushi Italian', containerTags: ['user_123'], limit: 5 });
const foundDeleted = afterDelete.results.some(r => r.id === mem5.id);
assert(!foundDeleted, 'Deleted memory not in search results');

engine.restore(mem5.id);
const afterRestore = await engine.search({ q: 'sushi Italian', containerTags: ['user_123'], limit: 5 });
const foundRestored = afterRestore.results.some(r => r.id === mem5.id);
assert(foundRestored, 'Restored memory back in search results');

console.log('');

// ---- TEST 9: Stats ----
console.log('TEST 9: Stats');
const stats = engine.getStats(['user_123']);
assert(stats.total >= 5, `Total: ${stats.total} memories`);
assert(stats.byType.static >= 3, `Static: ${stats.byType.static}`);
assert(stats.byType.dynamic >= 1 || stats.byType.episodic >= 1, 'Has dynamic/episodic memories');
console.log('  Stats:', JSON.stringify(stats));

console.log('');

// ---- TEST 10: Export ----
console.log('TEST 10: Export');
const exported = engine.exportAll(['user_123']);
assert(exported.length >= 5, `Exported ${exported.length} memories`);
assert(exported[0].tags.length > 0, 'Exported memories have tags');

console.log('');

// ---- TEST 11: Cleanup (dry run) ----
console.log('TEST 11: Cleanup (dry run)');
const cleanup = engine.cleanup({ maxAgeDays: 0, dryRun: true }); // 0 days = flag everything
// Only low-importance, low-access, dynamic memories should be flagged
assert(typeof cleanup.wouldDelete === 'number', `Cleanup would delete ${cleanup.wouldDelete} stale memories`);

console.log('');

// ---- TEST 12: DB file exists in same folder ----
console.log('TEST 12: DB persistence');
assert(existsSync(DB_PATH), `DB file exists at: ${DB_PATH}`);

engine.close();

// ---- Verify data survives restart ----
const engine2 = new MemoryEngine({ dbPath: DB_PATH });
const reloadSearch = await engine2.search({ q: 'Alex London', containerTags: ['user_123'], limit: 1 });
assert(reloadSearch.results.length > 0, 'Data survives engine restart');
assert(reloadSearch.results[0].content.includes('Alex'), 'Content intact after reload');
engine2.close();

console.log('');
console.log('===========================================');
console.log(` RESULTS: ${passed} passed, ${failed} failed`);
console.log('===========================================');

if (failed > 0) process.exit(1);
