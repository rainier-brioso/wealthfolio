//! Kraken activity amounts, fees, and transfers retain their original currencies.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

mod support;

use rust_decimal::Decimal;
use support::*;
use wealthfolio_portfolio_engine::model::*;
use wealthfolio_portfolio_engine::project;

#[test]
fn multicurrency_trades_transfer_and_in_kind_fee_preserve_accounting() {
    let scenario: Scenario = serde_yaml::from_str(
        r#"
id: KRAKEN-MULTICURRENCY-01
policy: { base_currency: EUR, timezone: UTC, as_of: 2025-01-04 }
accounts:
  - { id: exchange, currency: EUR, cost_basis_method: FIFO }
  - { id: wallet, currency: USD, cost_basis_method: FIFO }
assets:
  - { id: BTC-EUR, quote_ccy: EUR, instrument_type: CRYPTO }
activities:
  - { id: deposit-eur, account: exchange, type: DEPOSIT, date: 2025-01-01T09:00:00Z, amount: 100, currency: EUR }
  - { id: deposit-usd, account: exchange, type: DEPOSIT, date: 2025-01-01T09:01:00Z, amount: 100, currency: USD }
  - { id: buy-eur, account: exchange, type: BUY, date: 2025-01-01T10:00:00Z, asset: BTC-EUR, quantity: 1, unit_price: 10, amount: 10, currency: EUR }
  - { id: buy-usd, account: exchange, type: BUY, date: 2025-01-01T11:00:00Z, asset: BTC-EUR, quantity: 2, unit_price: 20, amount: 40, currency: USD }
  - { id: sell-usd, account: exchange, type: SELL, date: 2025-01-02T10:00:00Z, asset: BTC-EUR, quantity: 1, unit_price: 25, amount: 24, fee: 1, currency: USD }
  - { id: transfer-out, account: exchange, type: TRANSFER_OUT, date: 2025-01-03T10:00:00Z, asset: BTC-EUR, quantity: 0.5, currency: EUR, source_group_id: kraken-wallet-transfer }
  - { id: transfer-in, account: wallet, type: TRANSFER_IN, date: 2025-01-03T10:00:00Z, asset: BTC-EUR, quantity: 0.5, currency: EUR, source_group_id: kraken-wallet-transfer }
  - { id: fee-in-kind, account: exchange, type: FEE, subtype: FEE_IN_KIND, date: 2025-01-03T10:00:00Z, asset: BTC-EUR, quantity: 0.1, amount: 2, currency: USD }
fx_rates:
  - { from: USD, to: EUR, day: 2025-01-01, rate: 0.9 }
  - { from: USD, to: EUR, day: 2025-01-02, rate: 0.9 }
  - { from: USD, to: EUR, day: 2025-01-03, rate: 0.9 }
  - { from: USD, to: EUR, day: 2025-01-04, rate: 0.9 }
"#,
    )
    .expect("scenario");
    let pipeline = Pipeline::from_scenario(&scenario);
    let ledger = pipeline.ledger();
    let fee = ledger
        .events
        .iter()
        .find(|event| event.id.as_str() == "fee-in-kind")
        .expect("fee event");
    assert_eq!(fee.cash, None, "in-kind fee must not spend fiat cash");

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
    let btc = AssetId::new("BTC-EUR");
    assert_eq!(
        exchange.cash[&Currency::parse("EUR").unwrap()],
        Decimal::from(90)
    );
    assert_eq!(
        exchange.cash[&Currency::parse("USD").unwrap()],
        Decimal::from(84)
    );
    assert_eq!(
        wallet
            .cash
            .get(&Currency::parse("USD").unwrap())
            .copied()
            .unwrap_or_default(),
        Decimal::ZERO
    );
    assert_eq!(exchange.positions[&btc].quantity, Decimal::new(14, 1));
    assert_eq!(wallet.positions[&btc].quantity, Decimal::new(5, 1));
    assert_eq!(
        exchange.positions[&btc]
            .total_cost_basis
            .round_dp(STORED_PRECISION),
        Decimal::new(252, 1)
    );
    assert_eq!(
        wallet.positions[&btc]
            .total_cost_basis
            .round_dp(STORED_PRECISION),
        Decimal::from(9)
    );

    let sell = bundle
        .disposals
        .iter()
        .find(|disposal| disposal.event.as_str() == "sell-usd")
        .expect("sell disposal");
    assert_eq!(
        sell.realized_pnl_base.round_dp(STORED_PRECISION),
        Decimal::new(116, 1)
    );
    assert!(
        bundle
            .disposals
            .iter()
            .filter(|d| d.event.as_str() != "sell-usd")
            .all(|disposal| disposal.realized_pnl_base.is_zero()),
        "transfer and in-kind fee must not realize a sale"
    );
}
