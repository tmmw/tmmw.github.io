(() => {
	const config = window.TMMW_SUPABASE_CONFIG;
	const loginPanel = document.getElementById("login-panel");
	const dashboard = document.getElementById("dashboard");
	const loginForm = document.getElementById("login-form");
	const loginButton = document.getElementById("login-button");
	const loginStatus = document.getElementById("login-status");
	const dashboardStatus = document.getElementById("dashboard-status");
	const licensesList = document.getElementById("licenses-list");
	const ordersList = document.getElementById("orders-list");
	const checkoutPanel = document.getElementById("checkout-panel");
	const checkoutButton = document.getElementById("checkout-button");
	const checkoutStatus = document.getElementById("checkout-status");
	const pageParams = new URLSearchParams(window.location.search);
	const requestedSku = /^[a-z0-9][a-z0-9_-]{1,63}$/i.test(pageParams.get("buy") ?? "") ? pageParams.get("buy") : "";
	let supabaseClient;
	let latestLoadId = 0;

	const checkoutErrors = {
		product_unavailable: "This product isn’t available for direct purchase yet.",
		invalid_product: "This product link isn’t valid.",
		unauthorized: "Please sign in again before checking out.",
		origin_not_allowed: "Checkout can only be started from the TMMW website."
	};

	function showCheckout() {
		if (!requestedSku) return;
		checkoutPanel.classList.remove("hidden");
		document.getElementById("checkout-product").textContent = `Product: ${requestedSku}`;
	}

	async function startCheckout() {
		checkoutButton.disabled = true;
		setStatus(checkoutStatus, "Opening secure checkout…");
		const { data, error } = await supabaseClient.functions.invoke("create-checkout", { body: { sku: requestedSku } });
		if (!error && typeof data?.url === "string" && data.url.startsWith("https://checkout.stripe.com/")) {
			window.location.assign(data.url);
			return;
		}
		let code = "";
		try { code = (await error?.context?.json())?.error ?? ""; } catch { /* non-JSON error body */ }
		console.error("Checkout could not start", code || error);
		setStatus(checkoutStatus, checkoutErrors[code] ?? "Checkout is unavailable right now. Please try again shortly.", "error");
		checkoutButton.disabled = false;
	}

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

	function relation(value) {
		return Array.isArray(value) ? value[0] : value;
	}

	function formatMinor(amount, currency) {
		const code = (currency || "USD").toUpperCase();
		const fractionDigits = new Intl.NumberFormat("en", { style: "currency", currency: code })
			.resolvedOptions().maximumFractionDigits;
		return new Intl.NumberFormat(undefined, { style: "currency", currency: code })
			.format((amount ?? 0) / (10 ** fractionDigits));
	}

	function showSignedOut(message = "") {
		loginPanel.classList.remove("hidden");
		dashboard.classList.add("hidden");
		if (message) setStatus(loginStatus, message);
	}

	async function loadDashboard(user) {
		loginPanel.classList.add("hidden");
		dashboard.classList.remove("hidden");
		document.getElementById("signed-in-email").textContent = user.email ?? "Signed in";
		showCheckout();
		setStatus(dashboardStatus, "Loading your account…");
		const loadId = ++latestLoadId;

		const [licenseResult, orderResult] = await Promise.all([
			supabaseClient.from("licenses")
				.select("id,status,activation_limit,issued_at,expires_at,products(name,sku),license_activations(id,device_label,status,activated_at,last_validated_at)")
				.order("created_at", { ascending: false }),
			supabaseClient.from("orders")
				.select("id,status,currency,subtotal_amount,tax_amount,total_amount,created_at,paid_at,order_items(quantity,unit_amount,currency,products(name,sku))")
				// Unpaid, abandoned and failed checkouts aren't purchases; don't show them to customers.
				.not("status", "in", "(pending,failed,expired)")
				.order("created_at", { ascending: false })
		]);
		// Sign-in fires several auth events; only the newest load may render.
		if (loadId !== latestLoadId) return;
		licensesList.replaceChildren();
		ordersList.replaceChildren();

		if (licenseResult.error || orderResult.error) {
			console.error("Could not load account records", licenseResult.error ?? orderResult.error);
			setStatus(dashboardStatus, "We couldn’t load your account. Please refresh and try again.", "error");
			return;
		}

		for (const license of licenseResult.data ?? []) {
			const product = relation(license.products);
			const activations = license.license_activations ?? [];
			const label = product?.name ?? "Plugin license";
			const activationSummary = activations.length
				? `${activations.filter((item) => item.status === "active").length} active of ${license.activation_limit} activations`
				: `No activations yet · limit ${license.activation_limit}`;
			const statusText = license.status === "pending"
				? "Payment received; license issuance is being completed."
				: `License status: ${license.status}`;
			licensesList.append(makeRecord(label, [
				[statusText],
				[activationSummary, "record-meta"],
				["License keys and device controls will appear when licensing is connected.", "record-meta"]
			]));
		}
		if (!licenseResult.data?.length) {
			licensesList.append(makeRecord("No licenses yet", [["Licenses from completed purchases will appear here."]]));
		}

		for (const order of orderResult.data ?? []) {
			const lines = (order.order_items ?? []).map((item) => {
				const product = relation(item.products);
				const name = product?.name ?? "Plugin";
			return `${name} · ${item.quantity} × ${formatMinor(item.unit_amount, item.currency)}`;
			});
			const total = order.total_amount === null
				? "Total pending"
				: `Total ${formatMinor(order.total_amount, order.currency)}`;
			ordersList.append(makeRecord(`Order · ${new Date(order.created_at).toLocaleDateString()}`, [
				[lines.join("; ") || "Order details pending"],
				[`Status: ${order.status} · ${total}`, "record-meta"]
			]));
		}
		if (!orderResult.data?.length) {
			ordersList.append(makeRecord("No orders yet", [["Your purchases will appear here."]]));
		}
		setStatus(dashboardStatus, pageParams.get("checkout") === "complete"
			? "Thanks! Your payment is being confirmed — refresh in a moment if your order isn’t marked paid yet."
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
			options: { emailRedirectTo: new URL(requestedSku ? `/account/?buy=${encodeURIComponent(requestedSku)}` : "/account/", window.location.origin).toString() }
		});
		loginButton.disabled = false;
		if (error) {
			console.error("Could not send sign-in link", error);
			setStatus(loginStatus, "We couldn’t send the sign-in link. Please check the address and try again.", "error");
			return;
		}
		setStatus(loginStatus, "Check your email for a secure sign-in link.");
	});

	checkoutButton.addEventListener("click", () => void startCheckout());

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
