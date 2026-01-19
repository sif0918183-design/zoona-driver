const { test, expect } = require('@playwright/test');

test('Passenger can see their rides', async ({ page }) => {
  // 1. Setup mock data in localStorage
  await page.goto('/');
  await page.evaluate(() => {
    const mockUser = {
      id: 'mock-uuid-123',
      full_name: 'محمد أحمد',
      phone: '0912345678'
    };
    localStorage.setItem('tarhal_customer', JSON.stringify(mockUser));
  });

  // 2. Reload page to initialize with mock user
  await page.reload();

  // 3. Navigate to "My Rides" tab
  // The tab is the second button in the passenger-interface tabs-container
  const myRidesTab = page.locator('#passenger-interface .tab').filter({ hasText: 'رحلاتي' });
  await myRidesTab.click();

  // 4. Wait for the list container to be visible
  const ridesList = page.locator('#my-rides-list');
  await expect(ridesList).toBeVisible();

  // 5. Take a screenshot
  await page.screenshot({ path: 'rides-tab.png' });
});
