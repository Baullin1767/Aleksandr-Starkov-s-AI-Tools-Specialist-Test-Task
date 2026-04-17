function requireEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return value;
    }
  }

  throw new Error(`Missing required environment variable. Expected one of: ${names.join(", ")}`);
}

export const appEnv = {
  supabaseUrl: requireEnv("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"),
  supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"),
  ordersTable: process.env.ORDERS_TABLE || "retailcrm_orders",
  displayTimezone: process.env.DISPLAY_TIMEZONE || "Europe/Moscow",
  displayLocale: process.env.DISPLAY_LOCALE || "en-GB",
};
