// Daily totals the phone reports (ml and goal per local day). See docs/SOCIAL.md §4.
// TODO(agent B): implement.

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';

export const totalsRoutes = new Hono<AppEnv>();

totalsRoutes.use('*', requireUser);
