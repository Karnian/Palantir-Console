const fs = require('fs/promises');
const path = require('path');

function createProviderService({ authPath }) {
  async function listRegisteredProviders() {
    let data;
    try {
      data = await fs.readFile(authPath, 'utf8');
    } catch (err) {
      return [];
    }

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      return [];
    }

    if (!parsed || typeof parsed !== 'object') return [];
    return Object.keys(parsed).sort();
  }

  return { listRegisteredProviders };
}

module.exports = { createProviderService };
