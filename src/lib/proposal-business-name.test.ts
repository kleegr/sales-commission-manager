import assert from 'node:assert/strict';
import {resolveBusinessName} from './proposal-business-name';

assert.equal(resolveBusinessName('At [Business name], we help.', 'Kleegr'), 'At Kleegr, we help.');
assert.equal(resolveBusinessName('[Your Company Name] / {{business_name}}', 'A$&B'), 'A$&B / A$&B');
assert.equal(resolveBusinessName('At [Business name], we help.', '  '), 'At our company, we help.');
assert.equal(resolveBusinessName('Keep [USD 20] and client names intact.', 'Kleegr'), 'Keep [USD 20] and client names intact.');
assert.equal(resolveBusinessName('No placeholder here.', 'Kleegr'), 'No placeholder here.');
console.log('5 business-name regression checks passed');
