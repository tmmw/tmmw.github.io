(() => {
	const config = window.TMMW_SUPABASE_CONFIG;
	const loginPanel = document.getElementById("login-panel");
	const dashboard = document.getElementById("dashboard");
	const loginForm = document.getElementById("login-form");
	const loginButton = document.getElementById("login-button");
	const loginStatus = document.getElementById("login-status");
	const dashboardStatus = document.getElementById("dashboard-status");
	const subscriptionDetails = document.getElementById("subscription-details");
	const planOptions = document.getElementById("plan-options");
	const checkoutStatus = document.getElementById("checkout-status");
	const pageParams = new URLSearchParams(window.location.search);
	let supabaseClient;
	let latestLoadId = 0;

	// Matches has_active_subscription() on the server: paying, trialing, or past due while Stripe retries.
	const ACCESS_STATUSES = ["trialing", "active", "past_due"];
	const STATUS_TEXT = {
		trialing: "Free trial",
		active: "Active",
		past_due: "Payment issue — Stripe is retrying your card; access continues for now.",
		canceled: "Canceled",
		unpaid: "Unpaid — access paused",
		incomplete: "Waiting for first payment",
		incomplete_expired: "Checkout not completed",
		paused: "Paused"
	};
	const checkoutErrors = {
		already_subscribed: "You already have an active subscription.",
		plan_unavailable: "This plan isn’t available yet.",
		unauthorized: "Please sign in again before subscribing.",
		origin_not_allowed: "Checkout can only be started from the TMMW website."
	};

	function setStatus(element, message, kind = "info") {
		element.textContent = message;
		element.dataset.kind = kind;
	}

	function makeRecord(title, lines) {
		const article = document.createElement("article");
		article.className = "record";
		const heading = document.createElement("h3");
		heading.textContent = title;
		article.append(heading);
		for (const [text, className = ""] of lines) {
			const paragraph = document.createElement("p");
			paragraph.textContent = text;
			if (className) paragraph.className = className;
			article.append(paragraph);
		}
		return article;
	}

	function formatMinor(amount, currency) {
		const code = (currency || "EUR").toUpperCase();
		const fractionDigits = new Intl.NumberFormat("en", { style: "currency", currency: code })
			.resolvedOptions().maximumFractionDigits;
		return new Intl.NumberFormat(undefined, { style: "currency", currency: code })
			.format((amount ?? 0) / (10 ** fractionDigits));
	}

	function formatDate(value) {
		return value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "long" }) : "";
	}

	function showSignedOut(message = "") {
		loginPanel.classList.remove("hidden");
		dashboard.classList.add("hidden");
		if (message) setStatus(loginStatus, message);
	}

	function renderSubscription(subscription) {
		const interval = subscription.billing_interval === "year" ? "Yearly" : "Monthly";
		const lines = [[STATUS_TEXT[subscription.status] ?? `Status: ${subscription.status}`]];
		if (ACCESS_STATUSES.includes(subscription.status) && subscription.current_period_end) {
			const end = formatDate(subscription.current_period_end);
			lines.push([subscription.cancel_at_period_end
				? `Ends on ${end} — it won’t renew.`
				: subscription.status === "trialing"
					? `Trial ends on ${end}; your first payment is taken then.`
					: `Renews on ${end}.`, "record-meta"]);
		}
		lines.push(["To change or cancel, use the link in your Stripe receipt email, or contact us.", "record-meta"]);
		subscriptionDetails.append(makeRecord(`TMMW subscription · ${interval}`, lines));
	}

	function renderPlans(prices, offerTrial) {
		planOptions.replaceChildren();
		const ordered = [...prices].sort((a, b) => (a.billing_interval === "year") - (b.billing_interval === "year"));
		for (const price of ordered) {
			const button = document.createElement("button");
			button.type = "button";
			const amount = price.billing_interval === "year"
				? `${formatMinor(price.unit_amount, price.currency)}/year`
				: `${formatMinor(price.unit_amount, price.currency)}/month`;
			const label = price.billing_interval === "year" ? "Yearly" : "Monthly";
			button.textContent = offerTrial ? `${label} · 14 days free, then ${amount}` : `${label} · ${amount}`;
			button.addEventListener("click", () => void startCheckout(price.billing_interval));
			planOptions.append(button);
		}
		planOptions.classList.toggle("hidden", !ordered.length);
		if (!ordered.length) setStatus(checkoutStatus, "Subscriptions aren’t open yet.");
	}

	async function startCheckout(interval) {
		for (const button of planOptions.querySelectorAll("button")) button.disabled = true;
		setStatus(checkoutStatus, "Opening secure checkout…");
		const { data, error } = await supabaseClient.functions.invoke("create-checkout", { body: { interval } });
		if (!error && typeof data?.url === "string" && data.url.startsWith("https://checkout.stripe.com/")) {
			window.location.assign(data.url);
			return;
		}
		let code = "";
		try { code = (await error?.context?.json())?.error ?? ""; } catch { /* non-JSON error body */ }
		console.error("Checkout could not start", code || error);
		setStatus(checkoutStatus, checkoutErrors[code] ?? "Checkout is unavailable right now. Please try again shortly.", "error");
		for (const button of planOptions.querySelectorAll("button")) button.disabled = false;
	}

	async function loadDashboard(user) {
		loginPanel.classList.add("hidden");
		dashboard.classList.remove("hidden");
		document.getElementById("signed-in-email").textContent = user.email ?? "Signed in";
		setStatus(dashboardStatus, "Loading your account…");
		const loadId = ++latestLoadId;

		const [subscriptionResult, priceResult] = await Promise.all([
			supabaseClient.from("subscriptions")
				.select("status,billing_interval,current_period_end,cancel_at_period_end,created_at")
				.order("created_at", { ascending: false }),
			supabaseClient.from("product_prices")
				.select("billing_interval,unit_amount,currency")
				.not("billing_interval", "is", null)
		]);
		// Sign-in fires several auth events; only the newest load may render.
		if (loadId !== latestLoadId) return;
		subscriptionDetails.replaceChildren();

		if (subscriptionResult.error || priceResult.error) {
			console.error("Could not load account records", subscriptionResult.error ?? priceResult.error);
			setStatus(dashboardStatus, "We couldn’t load your account. Please refresh and try again.", "error");
			return;
		}

		const subscriptions = subscriptionResult.data ?? [];
		const current = subscriptions.find((item) => ACCESS_STATUSES.includes(item.status));
		if (current) {
			renderSubscription(current);
			planOptions.classList.add("hidden");
			setStatus(checkoutStatus, "");
		} else {
			const last = subscriptions.find((item) => item.status !== "incomplete_expired");
			subscriptionDetails.append(last
				? makeRecord("No active subscription", [["Your previous subscription has ended. Subscribe again to keep using TMMW plugins."]])
				: makeRecord("No subscription yet", [["One subscription unlocks every TMMW plugin. New subscribers get a 14-day free trial."]]));
			// Mirrors create-checkout: only accounts that never subscribed get the trial.
			renderPlans(priceResult.data ?? [], !subscriptions.some((item) => item.status !== "incomplete_expired"));
		}

		const justSubscribed = pageParams.get("checkout") === "complete";
		setStatus(dashboardStatus, justSubscribed && !current
			? "Thanks! Your payment is being confirmed — refresh in a moment if your subscription isn’t shown yet."
			: "Account details are up to date.");
	}

	if (!window.supabase?.createClient || !config?.url || config.url.includes("YOUR_PROJECT_REF") ||
		!config?.publishableKey || config.publishableKey.includes("YOUR_SUPABASE_PUBLISHABLE_KEY")) {
		loginButton.disabled = true;
		setStatus(loginStatus, "Account sign-in is not connected yet. Supabase project settings are required before launch.", "error");
		return;
	}

	supabaseClient = window.supabase.createClient(config.url, config.publishableKey);

	loginForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		loginButton.disabled = true;
		setStatus(loginStatus, "Sending your secure sign-in link…");
		const email = new FormData(loginForm).get("email").toString().trim();
		const { error } = await supabaseClient.auth.signInWithOtp({
			email,
			options: { emailRedirectTo: new URL("/account/", window.location.origin).toString() }
		});
		loginButton.disabled = false;
		if (error) {
			console.error("Could not send sign-in link", error);
			setStatus(loginStatus, "We couldn’t send the sign-in link. Please check the address and try again.", "error");
			return;
		}
		setStatus(loginStatus, "Check your email for a secure sign-in link.");
	});

	document.getElementById("sign-out-button").addEventListener("click", async () => {
		const { error } = await supabaseClient.auth.signOut();
		if (error) setStatus(dashboardStatus, "Could not sign out. Please try again.", "error");
	});

	supabaseClient.auth.onAuthStateChange((_event, session) => {
		if (session?.user) {
			void loadDashboard(session.user);
		} else {
			showSignedOut();
		}
	});

	supabaseClient.auth.getSession().then(({ data, error }) => {
		if (error) {
			showSignedOut("Your sign-in session couldn’t be checked. Please try again.");
			return;
		}
		if (data.session?.user) void loadDashboard(data.session.user);
	});
})();
