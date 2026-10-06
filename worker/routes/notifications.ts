// In-app notifications: list and mark read. See docs/SOCIAL.md §4 "Notifications".
// TODO(agent B): implement.

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';

export const notificationsRoutes = new Hono<AppEnv>();

notificationsRoutes.use('*', requireUser);
