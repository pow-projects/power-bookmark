import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource/outfit/700.css';
import { mount } from 'svelte';
import App from './App.svelte';
import '../../assets/styles/design-system.css';
import '../../assets/styles/components.css';

if (typeof browser !== 'undefined' && browser.i18n?.getUILanguage) {
  document.documentElement.lang = browser.i18n.getUILanguage();
}

const app = mount(App, {
  target: document.getElementById('app')!
});

export default app;
