import os
import json
from playwright.sync_api import sync_playwright

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={'width': 450, 'height': 900},
            is_mobile=True,
            has_touch=True,
            locale='ar-SA'
        )

        page = context.new_page()
        page.on('console', lambda msg: print(f"[Page 1 Console] {msg.type}: {msg.text}"))

        # Intercept and mock /api/supabase-config API request
        page.route("**/api/supabase-config", lambda route: route.fulfill(
            status=200,
            content_type="application/javascript",
            body="window.SB_URL = 'https://mock.supabase.co'; window.SB_KEY = 'mock_anon_key';"
        ))

        page.route("**/api/turnstile-config", lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body='{"success": true, "siteKey": "1x00000000000000000000AA"}'
        ))

        # Mock general Supabase responses
        page.route("**/rest/v1/**", lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body='[]'
        ))

        # Navigate to driver app
        page.goto('http://localhost:8080/driver_app/index.html')
        page.wait_for_timeout(1000)

        # Click the link to register
        page.click('text=سجل كسائق الآن')
        page.wait_for_timeout(1000)

        # Agree to driver agreement terms
        if page.is_visible('#driver-agreement-modal'):
            page.click('text=أوافق على جميع البنود')
            page.wait_for_timeout(500)

        # Take a screenshot of the registration form
        os.makedirs('./verification', exist_ok=True)
        page.screenshot(path='./verification/driver_register_form.png')
        print("Driver registration form screenshot taken!")

        # Let's populate some values in the form
        page.fill('#register-fullname', 'أحمد محمد علي حسن')
        page.fill('#register-whatsapp', '249123456789')
        page.fill('#register-phone', '249987654321')
        page.fill('#register-password', '123456')
        page.fill('#register-carmodel', 'توسان 2016')
        page.fill('#register-platenumber', 'خ/2 1234')
        page.fill('#register-carcolor', 'أبيض')

        # Take another screenshot of populated form
        page.screenshot(path='./verification/driver_register_populated.png')
        print("Populated driver registration form screenshot taken!")

        # Now let's test admin-login.html
        page2 = context.new_page()
        page2.on('console', lambda msg: print(f"[Page 2 Console] {msg.type}: {msg.text}"))

        # Dynamic Mocking for Admin API
        def handle_admin_api(route):
            try:
                post_data = json.loads(route.request.post_data)
                action = post_data.get("action")
            except Exception:
                action = None

            print(f"Intercepted Admin API - Action: {action}")

            response_body = {"success": True}
            if action == "login":
                response_body = {"success": True, "token": "mock_token"}
            elif action == "get_stats":
                response_body = {
                    "success": True,
                    "stats": {"customers": 5, "drivers": 10, "activeRides": 2, "earnings": 150000},
                    "adminWhatsapp": "249111991551"
                }
            elif action == "get_instant_vehicles":
                response_body = {
                    "success": True,
                    "vehicles": [
                        {"id": "economy", "name": "توفير", "icon": "🚗", "base": 6000, "perKm": 3000, "travelMultiplier": 1.0},
                        {"id": "comfort", "name": "مريح", "icon": "🚙", "base": 7000, "perKm": 3500, "travelMultiplier": 1.3}
                    ]
                }
            elif action == "list_customers":
                response_body = {"success": True, "customers": []}
            elif action == "list_drivers":
                response_body = {"success": True, "drivers": []}
            elif action == "list_pending_drivers":
                response_body = {
                    "success": True,
                    "drivers": [
                        {
                            "id": "pending-1",
                            "full_name": "أحمد محمد علي حسن",
                            "whatsapp_number": "249123456789",
                            "phone": "249987654321",
                            "car_model": "توسان 2016",
                            "plate_number": "خ/2 1234",
                            "car_color": "أبيض",
                            "license_image_url": "https://placehold.co/150",
                            "vehicle_registration_url": "https://placehold.co/150",
                            "car_photo_url": "https://placehold.co/150",
                            "plate_photo_url": "https://placehold.co/150",
                            "car_type": "economy"
                        }
                    ]
                }

            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps(response_body)
            )

        page2.route("**/api/admin", handle_admin_api)

        page2.goto('http://localhost:8080/admin-login.html')
        page2.wait_for_timeout(1000)

        # Fill passcode and click login
        page2.fill('#admin-password', '1234')
        # Let's look for the submit button by class or id or content to be precise
        page2.click('#login-screen button')
        page2.wait_for_timeout(2000)

        # Take a screenshot of admin panel dashboard
        page2.screenshot(path='./verification/admin_panel.png')
        print("Admin panel screenshot taken!")

        # Let's try to click the pending-approvals tab
        # We can select it by clicking specifically the tab element or by selector
        # Tab index 2 is pending activations ("طلبات التفعيل الجديدة")
        page2.click('.tabs div:has-text("طلبات التفعيل الجديدة")')
        page2.wait_for_timeout(1000)

        # Take screenshot of pending approvals tab
        page2.screenshot(path='./verification/admin_pending_approvals.png')
        print("Admin pending approvals tab screenshot taken!")

        browser.close()

if __name__ == "__main__":
    run()
