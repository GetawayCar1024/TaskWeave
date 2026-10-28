import './lib/migrateStorage';
import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import { i18n } from './i18n';
import './style.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'problems', component: () => import('./views/ProblemList.vue') },
    { path: '/p/:id', name: 'problem', component: () => import('./views/ProblemWorkspace.vue'), props: true },
    { path: '/p/:id/print', name: 'problem-print', component: () => import('./views/ContestPrint.vue'), props: route => ({ id: route.params.id, single: true }) },
    { path: '/c/:id', name: 'contest', component: () => import('./views/ContestView.vue'), props: true },
    { path: '/c/:id/print', name: 'contest-print', component: () => import('./views/ContestPrint.vue'), props: true },
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
    { path: '/trash', name: 'trash', component: () => import('./views/TrashView.vue') },
  ],
});

/*
 * After TaskWeave is rebuilt or updated, an open tab still refers to the old page
 * chunks, which are gone (404): navigation then silently fails ("the click does
 * nothing"). Reload to the requested page instead, once per target.
 */
const RELOAD_KEY = 'taskweave-chunk-reload';
let pending: string | null = null;
function reloadTo(path: string | null) {
  const target = path ?? location.pathname + location.search;
  if (sessionStorage.getItem(RELOAD_KEY) === target) return; // already tried: do not loop
  sessionStorage.setItem(RELOAD_KEY, target);
  location.assign(target);
}
router.beforeEach((to) => {
  pending = to.fullPath;
});
router.afterEach(() => sessionStorage.removeItem(RELOAD_KEY));
router.onError((err, to) => {
  if (/dynamically imported module|Importing a module script failed|Unable to preload|error loading dynamically/i.test(String((err as Error)?.message))) {
    reloadTo(to.fullPath);
  }
});
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault();
  reloadTo(pending);
});

createApp(App).use(i18n).use(router).mount('#app');
