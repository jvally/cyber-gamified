import './ui/styles.css';
import { App } from './ui/app';

let storage: Storage | null = null;
try { storage = window.localStorage; } catch { /* blocked: progress will not persist */ }
new App(document.getElementById('app')!, storage);
