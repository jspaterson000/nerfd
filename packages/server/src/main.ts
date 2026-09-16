#!/usr/bin/env node
import './quiet.ts';
import { startServer } from './index.ts';
import { ReportStore } from './store.ts';

const argv = process.argv.slice(2);
const get = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };

const port = Number(get('--port', process.env.PORT ?? '8787'));
const dbPath = get('--db', process.env.NERFD_DB ?? './reports.db');
const store = new ReportStore(dbPath);

startServer({ port, readOnly: false, store, title: 'nerfd' });
process.stdout.write(`nerfd server on http://localhost:${port}  db=${dbPath}  reports=${store.count()}\n`);
