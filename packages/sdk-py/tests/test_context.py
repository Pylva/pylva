"""Parity with TS context.test.ts — contextvars propagation."""

import asyncio

from pylva.core.context import current_context, track, track_context


def test_basic_context_shape() -> None:
    with track_context("cust_1") as ctx:
        assert ctx.customer_id == "cust_1"
        assert len(ctx.trace_id) == 36
        assert len(ctx.span_id) == 36
        assert ctx.parent_span_id is None
        assert current_context() is ctx


def test_nested_inherits_trace_id_and_parent_span_id() -> None:
    with track_context("cust_2") as outer:
        with track_context("cust_2") as inner:
            assert inner.trace_id == outer.trace_id
            assert inner.parent_span_id == outer.span_id
            assert inner.span_id != outer.span_id


def test_step_option() -> None:
    with track_context("cust_3", step="answer_question") as ctx:
        assert ctx.step_name == "answer_question"


def test_context_exits_on_completion() -> None:
    assert current_context() is None
    with track_context("cust_4"):
        assert current_context() is not None
    assert current_context() is None


def test_track_sync_fn_runs_inside_context() -> None:
    result = track("cust_sync", lambda: current_context())
    assert result is not None
    assert result.customer_id == "cust_sync"
    assert current_context() is None


async def test_track_async_fn_runs_inside_context() -> None:
    """Regression: the coroutine body executes after track() returns; the
    context must stay attached through the await (TS AsyncLocalStorage
    parity). Before the fix this saw current_context() is None → events
    attributed to 'anonymous' and customer-scoped rules bypassed."""

    async def fn():
        await asyncio.sleep(0)  # cross a suspension point before reading
        return current_context()

    ctx = await track("cust_async", fn)
    assert ctx is not None
    assert ctx.customer_id == "cust_async"
    assert current_context() is None


async def test_track_async_nested_inherits_trace() -> None:
    async def inner():
        return current_context()

    async def outer():
        outer_ctx = current_context()
        assert outer_ctx is not None
        inner_ctx = await track("cust_nested", inner)
        assert inner_ctx is not None
        assert inner_ctx.trace_id == outer_ctx.trace_id
        assert inner_ctx.parent_span_id == outer_ctx.span_id
        return outer_ctx

    await track("cust_nested", outer)
    assert current_context() is None


async def test_track_async_fn_exception_resets_context() -> None:
    async def boom():
        raise ValueError("provider exploded")

    try:
        await track("cust_err", boom)
    except ValueError:
        pass
    assert current_context() is None
