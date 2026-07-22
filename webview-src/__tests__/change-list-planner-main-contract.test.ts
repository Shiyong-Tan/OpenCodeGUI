import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../..');
const mainSource = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const featureSource = fs.readFileSync(path.join(root, 'webview-src', 'features', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');
const plannerSource = fs.readFileSync(path.join(root, 'webview-src', 'features', 'change-list', 'change-list-planner.ts'), 'utf8');

function extractFunction(marker: string): string {
  const start = mainSource.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const brace = mainSource.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < mainSource.length; index++) {
    if (mainSource[index] === '{') depth++;
    if (mainSource[index] === '}' && --depth === 0) return mainSource.slice(start, index + 1);
  }
  throw new Error(`unclosed ${marker}`);
}

describe('change-list materialization planner integration', () => {
  test('exposes only the planner through the existing frozen feature facade', () => {
    expect(featureSource).toContain("import { planChangeListMaterialization } from './change-list/change-list-planner';");
    expect(featureSource).toContain('  planChangeListMaterialization,');
    expect(featureSource).toContain('export const FEATURE_FACADE_VERSION = 1 as const;');
    expect(featureSource).not.toContain('window.__ocChangeList');
  });

  test('keeps the planner pure and main as the only materialization writer', () => {
    expect(plannerSource).not.toMatch(/\b(document|window|vscode)\b/);
    expect(plannerSource).not.toContain('session.');
    const materialize = extractFunction('function materializeInjectedChangeLists(');
    expect(mainSource).toContain('const planChangeListMaterialization = window.__ocFeatures?.planChangeListMaterialization;');
    expect(materialize).toContain('const plan = planChangeListMaterialization({');
    expect(materialize).toContain('session.messagesById.set(message.id, message);');
    expect(materialize).toContain('session.timeline = [...plan.timeline];');
    expect(materialize).not.toContain('findNearestPriorTimelineId');
  });
});
