// Supabase Configuration Shared File
// Ensures global SB_URL and SB_KEY are initialized with safe fallbacks if missing.

if (!window.SB_URL || window.SB_URL === '' || window.SB_URL === 'undefined') {
    window.SB_URL = 'https://zsmlyiygjagmhnglrhoa.supabase.co';
}

if (!window.SB_KEY || window.SB_KEY === '' || window.SB_KEY === 'undefined') {
    window.SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzbWx5aXlnamFnbWhuZ2xyaG9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDEzMjQ5NTUsImV4cCI6MjA1NjkwMDk1NX0.3iSvh3nL75f284sS6GkInlIny3e_1x8eH0p7J1vR9xQ';
}
