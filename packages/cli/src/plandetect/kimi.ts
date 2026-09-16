// Kimi Code plan detection - and mostly, a documented refusal.
//
// The membership tier (Adagio, Moderato, Allegretto, Allegro, Vivace) is NOT
// cached on disk. Everything found under ~/.kimi-code/ is credentials
// (credentials/kimi-code.json holds OAuth tokens; device_id is a device id).
// The tier is fetched live from Moonshot's usage endpoint, which requires
// sending the bearer token - transmitting a secret, which nerfd will never do
// for a display field, and a network call the privacy statement says the CLI
// does not make outside the share path.
//
// So there is no credentials file to open here at all, and nerfd opens none.
// The only thing that can honestly be detected is API-key mode from the
// environment, by variable name, without reading any value.
//
// See docs/PLAN-DETECTION.md. `nerfd plan kimi kimi-allegro` remains the way to
// get a Kimi plan on to a session.

import { detected, unknown, type Detection, type Detector } from './types.ts';
import { anyEnvSet } from './read.ts';

export const detectKimi: Detector = ({ env }): Detection => {
  const envVar = anyEnvSet(env, ['MOONSHOT_API_KEY', 'KIMI_API_KEY']);
  if (envVar) return detected('api', `env ${envVar} (set)`, 'high');
  return unknown();
};
