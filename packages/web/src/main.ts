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
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
  ],
});

createApp(App).use(i18n).use(router).mount('#app');
