# -*- coding: utf-8 -*-
"""
AI Render Tool - Rhino 씬 정보 추출 스크립트

1) Rhino MCP 경유: 서버가 이 파일을 execute_rhinoscript_python_code 로 그대로 실행한다.
2) 수동 실행: Rhino 에서 RunPythonScript -> 이 파일 선택.
   .3dm 파일 옆에 <파일명>_scene.json 이 저장되며, 웹 UI 의 "JSON 불러오기"로 올리면 된다.

활성 뷰포트의 카메라, 객체별 재질/레이어, 조명/태양, 씬 크기를 JSON 으로 출력한다.
객체 User Text 에 'ai' 로 시작하는 키(예: ai, ai_desc)를 넣으면 재질 설명 힌트로 함께 전달된다.
IronPython 2.7 / CPython 3 (Rhino 7, 8) 모두에서 동작하도록 f-string 등은 쓰지 않는다.
"""
import json
import math
import os

import Rhino
import scriptcontext as sc

MARK_START = "<<<AI_RENDER_SCENE_JSON>>>"
MARK_END = "<<<END_AI_RENDER_SCENE_JSON>>>"
MAX_NAMES = 8


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def _pt(p):
    return [round(p.X, 4), round(p.Y, 4), round(p.Z, 4)]


def _hex(c):
    return "#%02x%02x%02x" % (c.R, c.G, c.B)


def _material_name(obj, doc):
    rm = _safe(lambda: obj.RenderMaterial)
    if rm is not None and rm.Name:
        return rm.Name
    mat = _safe(lambda: obj.GetMaterial(True))
    if mat is not None and mat.Name:
        return mat.Name
    return "(default)"


def _ai_hints(obj):
    hints = []
    strings = _safe(lambda: obj.Attributes.GetUserStrings())
    if strings is None:
        return hints
    for key in strings.AllKeys:
        if key and key.lower().startswith("ai"):
            value = strings[key]
            if value:
                hints.append(value)
    return hints


def _camera(doc):
    view = doc.Views.ActiveView
    if view is None:
        return None
    vp = view.ActiveViewport
    cam = {
        "viewName": vp.Name,
        "projection": "parallel" if vp.IsParallelProjection else "perspective",
        "lensLength": round(vp.Camera35mmLensLength, 2),
        "location": _pt(vp.CameraLocation),
        "target": _pt(vp.CameraTarget),
        "up": [round(vp.CameraUp.X, 4), round(vp.CameraUp.Y, 4), round(vp.CameraUp.Z, 4)],
        "width": vp.Size.Width,
        "height": vp.Size.Height,
    }
    direction = vp.CameraDirection
    direction.Unitize()
    cam["pitchDeg"] = round(math.degrees(math.asin(max(-1.0, min(1.0, direction.Z)))), 1)
    return cam


def _sun(doc):
    sun = _safe(lambda: doc.RenderSettings.Sun) or _safe(lambda: doc.Lights.Sun)
    if sun is None:
        return None
    return {
        "enabled": bool(_safe(lambda: sun.Enabled, False)),
        "altitude": _safe(lambda: round(sun.Altitude, 1)),
        "azimuth": _safe(lambda: round(sun.Azimuth, 1)),
    }


def collect():
    doc = sc.doc
    out = {"source": "rhino", "version": 1}
    out["file"] = _safe(lambda: doc.Name)
    out["units"] = _safe(lambda: str(doc.ModelUnitSystem))
    out["camera"] = _safe(lambda: _camera(doc))
    out["sun"] = _sun(doc)

    settings = Rhino.DocObjects.ObjectEnumeratorSettings()
    settings.HiddenObjects = False
    settings.LockedObjects = True
    settings.NormalObjects = True
    settings.VisibleFilter = True

    materials = {}
    layers = {}
    lights = 0
    bbox = Rhino.Geometry.BoundingBox.Empty
    for obj in doc.Objects.GetObjectList(settings):
        if obj.ObjectType == Rhino.DocObjects.ObjectType.Light:
            lights += 1
            continue
        layer = _safe(lambda: doc.Layers[obj.Attributes.LayerIndex])
        layer_name = _safe(lambda: layer.FullPath, "(unknown)")
        mat_name = _material_name(obj, doc)
        obj_name = _safe(lambda: obj.Attributes.Name)

        m = materials.setdefault(mat_name, {"name": mat_name, "objects": 0, "layers": [], "objectNames": [], "hints": []})
        m["objects"] += 1
        if layer_name not in m["layers"]:
            m["layers"].append(layer_name)
        if obj_name and obj_name not in m["objectNames"] and len(m["objectNames"]) < MAX_NAMES:
            m["objectNames"].append(obj_name)
        for hint in _ai_hints(obj):
            if hint not in m["hints"]:
                m["hints"].append(hint)

        l = layers.setdefault(layer_name, {"name": layer_name, "objects": 0, "color": _safe(lambda: _hex(layer.Color))})
        l["objects"] += 1

        bb = _safe(lambda: obj.Geometry.GetBoundingBox(True))
        if bb is not None and bb.IsValid:
            bbox.Union(bb)

    out["materials"] = sorted(materials.values(), key=lambda m: -m["objects"])
    out["layers"] = sorted(layers.values(), key=lambda l: l["name"])
    out["lightCount"] = lights
    if bbox.IsValid:
        out["bounds"] = {"min": _pt(bbox.Min), "max": _pt(bbox.Max)}
        cam = out.get("camera")
        if cam:
            cam["heightAboveGround"] = round(cam["location"][2] - bbox.Min.Z, 3)
    out["namedViews"] = _safe(lambda: [v.Name for v in doc.NamedViews], [])
    return out


data = collect()
print(MARK_START + json.dumps(data) + MARK_END)

# 서버(MCP)에서 실행할 때는 __AI_RENDER_MCP__ = True 가 앞에 붙는다. 수동 실행일 때만 파일로 저장.
if not globals().get("__AI_RENDER_MCP__"):
    doc_path = _safe(lambda: sc.doc.Path)
    if doc_path:
        save_path = os.path.splitext(doc_path)[0] + "_scene.json"
    else:
        save_path = os.path.join(os.path.expanduser("~"), "Desktop", "rhino_scene.json")
    with open(save_path, "w") as f:
        json.dump(data, f, indent=2)
    print(u"씬 정보를 저장했습니다: " + save_path)
