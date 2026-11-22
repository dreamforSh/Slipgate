import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { i18n } from "./i18n";
import router from "./router";
import "./style.css";

const app = createApp(App);
app.use(createPinia());
app.use(i18n);
app.use(router);

// Mount only after the first navigation resolves so the shell never flashes
// before the auth/setup guards pick the right layout.
void router.isReady().then(() => app.mount("#app"));
