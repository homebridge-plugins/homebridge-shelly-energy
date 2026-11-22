// The plugin's page in the Homebridge UI: its server side. See handlers.js.
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { makeHandlers } from './handlers.js';

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    for (const [route, fn] of Object.entries(makeHandlers(this.homebridgeStoragePath))) {
      this.onRequest(route, async payload => { try { return await fn(payload); } catch (e) { throw new RequestError(e.message, {}); } });
    }
    this.ready();
  }
}
(() => new UiServer())();
