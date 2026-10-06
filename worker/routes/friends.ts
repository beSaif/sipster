// Friend requests and the friends list. See docs/SOCIAL.md §4 "Friends".
// TODO(agent B): implement.

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireUser, requireUsername } from '../lib/auth';

export const friendsRoutes = new Hono<AppEnv>();

friendsRoutes.use('*', requireUser, requireUsername);
