//! A fee charged in BTC consumes units while leaving account cash unchanged.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

mod support;

use rust_decimal::Decimal;
use support::*;
use wealthfolio_portfolio_engine::model::*;
use wealthfolio_portfolio_engine::{measure_account, project, MeasureProfile, Window};

#[test]
fn btc_transfer_and_in_kind_fee_preserve_basis_without_cash_flow() {
    let scenario: Scenario = serde_yaml::from_str(
        r#"
id: KRAKEN-BTC-FEE-01
policy: { base_currency: EUR, timezone: UTC, as_of: 2025-01-04 }
accounts:
  - { id: exchange, currency: EUR }
  - { id: wallet, currency: EUR }
assets:
  - { id: BTC-EUR, quote_ccy: EUR, instrument_type: CRYPTO }
activities:
  - { id: deposit, account: exchange, type: DEPOSIT, date: 2025-01-01T09:00:00Z, amount: 100 }
  - { id: buy, account: exchange, type: BUY, date: 2025-01-01T10:00:00Z, asset: BTC-EUR, quantity: 0.1, unit_price: 100, amount: 10 }
  - { id: transfer-out, account: exchange, type: TRANSFER_OUT, date: 2025-01-02T10:00:00Z, asset: BTC-EUR, quantity: 0.05, source_group_id: kraken-ref-1 }
  - { id: transfer-in, account: wallet, type: TRANSFER_IN, date: 2025-01-02T10:00:00Z, asset: BTC-EUR, quantity: 0.05, source_group_id: kraken-ref-1 }
  - { id: fee, account: exchange, type: FEE, subtype: FEE_IN_KIND, date: 2025-01-02T10:00:00Z, asset: BTC-EUR, quantity: 0.001, amount: 0.1, currency: USD }
fx_rates:
  - { from: USD, to: EUR, day: 2025-01-02, rate: 0.9 }
"#,
    )
    .expect("scenario");
    let pipeline = Pipeline::from_scenario(&scenario);
    let ledger = pipeline.ledger();
    let fee = ledger
        .events
        .iter()
        .find(|event| event.id.as_str() == "fee")
        .expect("fee event");
    assert_eq!(fee.cash, None, "the asset fee has no cash effect");
    assert_eq!(fee.charges, Charges::default());
    assert_eq!(fee.attribution.fee, Decimal::new(1, 1));
    assert_eq!(
        fee.flow,
        Flow::NONE,
        "the fee is not a portfolio boundary flow"
    );
    assert!(
        matches!(fee.action, Action::AssetFee { quantity, .. } if quantity == Decimal::new(1, 3))
    );

    let bundle = project(
        ledger,
        pipeline.facts(),
        &pipeline.fx(),
        None,
        pipeline.range(),
    )
    .expect("projection");
    assert!(
        bundle.rejected_activities().is_empty(),
        "{:?}",
        bundle.diagnostics
    );
    let exchange = &bundle.final_state.accounts[&AccountId::new("exchange")];
    let wallet = &bundle.final_state.accounts[&AccountId::new("wallet")];
    let asset = AssetId::new("BTC-EUR");

    assert_eq!(
        exchange.cash[&Currency::parse("EUR").unwrap()],
        Decimal::from(90)
    );
    assert_eq!(
        wallet
            .cash
            .get(&Currency::parse("EUR").unwrap())
            .copied()
            .unwrap_or_default(),
        Decimal::ZERO
    );
    assert_eq!(exchange.positions[&asset].quantity, Decimal::new(49, 3));
    assert_eq!(wallet.positions[&asset].quantity, Decimal::new(5, 2));
    assert_eq!(
        exchange.positions[&asset]
            .total_cost_basis
            .round_dp(STORED_PRECISION),
        Decimal::new(49, 1)
    );
    assert_eq!(
        wallet.positions[&asset]
            .total_cost_basis
            .round_dp(STORED_PRECISION),
        Decimal::from(5)
    );
    assert_eq!(bundle.disposals.len(), 2);
    assert!(
        bundle
            .disposals
            .iter()
            .all(|disposal| disposal.realized_pnl.is_zero()),
        "transfer and fee relief must not realize a sale"
    );
    assert!(bundle.closures.is_empty());

    let lots = pipeline.lots();
    let performance = measure_account(
        &pipeline.measure_inputs(&lots),
        &AccountId::new("exchange"),
        Window {
            start: None,
            end: Some("2025-01-04".parse().unwrap()),
        },
        MeasureProfile::Full,
        true,
    )
    .expect("fee attribution measurement");
    assert_eq!(performance.attribution.fees, Decimal::new(9, 2));
}
