import { syncMasterCatalog } from './services/tm_api.js';

async function run() {
  try {
    await syncMasterCatalog();
    console.log('Done testing scraper!');
  } catch (e) {
    console.error(e);
  }
}

run();
