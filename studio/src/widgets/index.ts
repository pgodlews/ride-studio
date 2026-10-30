/**
 * Widget registry: every family contributes a FamilyInfo and its widget list.
 * To add a design family, create src/widgets/<family>/index.tsx exporting
 * `family` and `widgets`, then add one line below.
 */
import { WidgetRegistry } from '../core/widget';
import * as broadcast from './broadcast';
import * as gauge from './gauge';
import * as glass from './glass';
import * as neon from './neon';

export const registry = new WidgetRegistry()
  .addFamily(glass.family, glass.widgets)
  .addFamily(broadcast.family, broadcast.widgets)
  .addFamily(gauge.family, gauge.widgets)
  .addFamily(neon.family, neon.widgets);
