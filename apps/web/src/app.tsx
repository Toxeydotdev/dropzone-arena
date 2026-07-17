import { ArenaGame } from '@dropzone-arena/arena-client';

import { parsePublicOnlineConfig } from './online-config';

export function App() {
  const online = parsePublicOnlineConfig(import.meta.env, {
    browserOrigin: window.location.origin,
    production: import.meta.env.PROD,
  });

  return <ArenaGame online={online} />;
}
