// Supabase Configuration Shared File
// This file is now a placeholder. The actual configuration is loaded from /api/supabase-config
// For backward compatibility, we initialize global variables if they are not already set.

if (!window.SB_URL || !window.SB_KEY) {
    console.warn('Supabase config not found in window. Loading from API...');
}
