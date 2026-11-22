import accounts from "./accounts";
import clash from "./clash";
import common from "./common";
import dashboard from "./dashboard";
import groups from "./groups";
import user from "./user";
import vms from "./vms";

export default {
  ...common,
  ...dashboard,
  ...groups,
  ...accounts,
  ...clash,
  ...vms,
  ...user,
};
