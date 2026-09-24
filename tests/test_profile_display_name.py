from pathlib import Path
import api.profiles as profiles


def test_profile_display_name_from_meta(tmp_path):
    # No profile.yaml
    assert profiles._profile_display_name_from_meta(tmp_path) == ""

    # profile.yaml with display_name
    meta_path = tmp_path / "profile.yaml"
    meta_path.write_text("display_name: Product Analyst\n", encoding="utf-8")
    assert profiles._profile_display_name_from_meta(tmp_path) == "Product Analyst"

    # profile.yaml with empty / whitespace display_name
    meta_path.write_text("display_name: '   '\n", encoding="utf-8")
    assert profiles._profile_display_name_from_meta(tmp_path) == ""


def test_list_profiles_api_includes_display_name():
    rows = profiles.list_profiles_api()
    assert isinstance(rows, list)
    for row in rows:
        assert "name" in row
        assert "display_name" in row
        assert isinstance(row["display_name"], str)
