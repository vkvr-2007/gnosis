import pytest

from gnosis.core.model_router import ModelRouter


@pytest.fixture
def router(settings):
    return ModelRouter(settings.models)


def test_default_goes_to_nebius(router):
    r = router.choose("planner")
    assert r.provider == "nebius" and not r.is_local


def test_private_data_stays_local(router):
    r = router.choose("planner", tags={"screen_text"})
    assert r.is_local and "screen_text" in r.reason


def test_offline_falls_back_for_allowed_roles(router):
    assert router.choose("fast", online=False).is_local
    with pytest.raises(RuntimeError):
        router.choose("vision", online=False)


def test_fallback_route(router):
    assert router.fallback(router.choose("planner")).is_local
    assert router.fallback(router.choose("vision")) is None
