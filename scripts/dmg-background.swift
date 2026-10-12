// 安装包（DMG）窗口的背景图。
//
// 一幅 640×400（@2x 渲染成 1280×800）的浅色渐变底：标题、中间那支指向
// 「应用程序」的箭头、底部一行首次打开的放行提示。与系统深浅色无关——
// DMG 窗口固定用这一张浅色底，读数最清楚。
//
// 产物 `scripts/dmg-background.png` 已随仓库提交，打包时直接复用；
// 要重新生成（改了文案或配色时）：
//
//   swiftc -O -target arm64-apple-macosx13.0 -sdk "$(xcrun --show-sdk-path)" \
//     -framework AppKit -framework CoreGraphics -framework ImageIO \
//     -o /tmp/oc-ferry-dmgbg scripts/dmg-background.swift
//   /tmp/oc-ferry-dmgbg scripts/dmg-background.png
import AppKit
import CoreGraphics
import Foundation
import ImageIO

func rgb(_ r: Int, _ g: Int, _ b: Int, _ a: CGFloat = 1) -> CGColor {
  CGColor(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: a)
}

func renderBackground(scale: CGFloat = 2) -> CGImage {
  let W: CGFloat = 640, H: CGFloat = 400
  let pw = Int(W * scale), ph = Int(H * scale)
  let cs = CGColorSpaceCreateDeviceRGB()
  // 不透明位图（noneSkipLast）：底图不需要透明通道，省掉 alpha 后 PNG 小一个量级
  guard
    let ctx = CGContext(
      data: nil, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: 0,
      space: cs, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
  else { fatalError("无法创建绘图上下文") }
  ctx.scaleBy(x: scale, y: scale)

  // 底：左上偏白、右下带一点蓝的浅灰渐变
  let bg = CGGradient(
    colorsSpace: cs,
    colors: [rgb(251, 252, 254), rgb(235, 238, 246)] as CFArray,
    locations: [0, 1])!
  ctx.drawLinearGradient(
    bg, start: CGPoint(x: 0, y: H), end: CGPoint(x: W, y: 0), options: [])

  func draw(_ text: String, size: CGFloat, weight: NSFont.Weight, color: CGColor, center: CGPoint) {
    let font = NSFont.systemFont(ofSize: size, weight: weight)
    let attrs: [NSAttributedString.Key: Any] = [
      .font: font, .foregroundColor: NSColor(cgColor: color) ?? .black,
    ]
    let s = NSAttributedString(string: text, attributes: attrs)
    let line = CTLineCreateWithAttributedString(s)
    let bounds = CTLineGetBoundsWithOptions(line, .useOpticalBounds)
    ctx.textPosition = CGPoint(x: center.x - bounds.width / 2, y: center.y - bounds.height / 2)
    CTLineDraw(line, ctx)
  }

  // 顶部标题（与应用同一套语气：不寒暄，直接说做什么）
  draw("安装 OC Ferry", size: 21, weight: .semibold, color: rgb(24, 26, 31), center: CGPoint(x: W / 2, y: H - 44))
  draw(
    "把左边这个应用拖进右边「应用程序」就行", size: 12.5, weight: .regular, color: rgb(118, 122, 132),
    center: CGPoint(x: W / 2, y: H - 68))

  // 两个图标之间的箭头：用应用主色（#0071e3）稍作透明的版本。
  // 整支箭头一个路径、一次填充——分两次填会在接缝处留下重叠的色块。
  let midY: CGFloat = H - 180
  let x0: CGFloat = 232, x1: CGFloat = 396
  let tail: CGFloat = 3.5, neck: CGFloat = 18, headBack: CGFloat = x1 - 38
  ctx.setFillColor(rgb(0, 113, 227, 0.72))
  ctx.beginPath()
  ctx.move(to: CGPoint(x: x0, y: midY + tail))
  ctx.addLine(to: CGPoint(x: headBack, y: midY + tail))
  ctx.addLine(to: CGPoint(x: headBack, y: midY + neck))
  ctx.addLine(to: CGPoint(x: x1, y: midY))
  ctx.addLine(to: CGPoint(x: headBack, y: midY - neck))
  ctx.addLine(to: CGPoint(x: headBack, y: midY - tail))
  ctx.addLine(to: CGPoint(x: x0, y: midY - tail))
  ctx.closePath()
  ctx.fillPath()

  // 底部一行小字：ad-hoc 签名没有公证，首次打开必被拦，先把放行方式写在眼前
  draw(
    "首次打开若被拦截：右键点 OC Ferry → 打开", size: 11, weight: .regular, color: rgb(146, 150, 162),
    center: CGPoint(x: W / 2, y: 26))

  guard let img = ctx.makeImage() else { fatalError("无法生成位图") }
  return img
}

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "dmg-background.png"
let image = renderBackground()
let url = URL(fileURLWithPath: out)
guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)
else { fatalError("无法创建输出：\(out)") }
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("写入失败：\(out)") }
print("已生成 \(out)")
