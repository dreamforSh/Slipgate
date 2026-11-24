import accounts from "./accounts";
import clash from "./clash";
import common from "./common";
import dashboard from "./dashboard";
import groups from "./groups";
import user from "./user";
import vms from "./vms";

import admin_users from "./admin_users";
import user_limits from "./user_limits";
import subscriptions from "./subscriptions";
import usage_logs from "./usage_logs";
import redeem from "./redeem";
import promo from "./promo";
import announcements_admin from "./announcements_admin";
import audit from "./audit";
import settings from "./settings";
import profile from "./profile";
import me from "./me";
import affiliate from "./affiliate";
import my_subscriptions from "./my_subscriptions";
import public_pages from "./public_pages";
import register from "./register";
import payments from "./payments";
import payment_flow from "./payment_flow";
import security from "./security";
import pricing from "./pricing";
import admin_tools from "./admin_tools";
import system_logs from "./system_logs";
import auth_guards from "./auth_guards";
import db_backups from "./db_backups";
import updates from "./updates";

export default {
  ...common,
  ...dashboard,
  ...groups,
  ...accounts,
  ...clash,
  ...vms,
  ...user,
  ...admin_users,
  ...user_limits,
  ...subscriptions,
  ...usage_logs,
  ...redeem,
  ...promo,
  ...announcements_admin,
  ...audit,
  ...settings,
  ...profile,
  ...me,
  ...affiliate,
  ...my_subscriptions,
  ...public_pages,
  ...register,
  ...payments,
  ...payment_flow,
  ...security,
  ...pricing,
  ...admin_tools,
  ...system_logs,
  ...auth_guards,
  ...db_backups,
  ...updates,
};
