'use strict';
const pin = require('./pin');

function capabilityVerdict({ systemInitCapabilities, sdkVersion, cliVersion, permissionMode } = {}) {
  const verdict = { observe: 'supported', prompt: 'unknown', tool_approval: 'supported', cancel: 'unknown', resume: 'supported' };
  if (sdkVersion !== pin.sdkVersion || cliVersion !== pin.cliVersion || permissionMode !== 'default') {
    return Object.fromEntries(Object.keys(verdict).map(key => [key, 'unsupported']));
  }
  if (systemInitCapabilities !== undefined) {
    const caps = Array.isArray(systemInitCapabilities) ? systemInitCapabilities : [];
    verdict.prompt = caps.includes('msg_lifecycle_v1') ? 'supported' : 'unsupported';
    verdict.cancel = caps.includes('interrupt_receipt_v1') ? 'supported' : 'unsupported';
  }
  return verdict;
}

module.exports = { capabilityVerdict };
