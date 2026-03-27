#!/usr/bin/env python3
"""
Generate narrated video for CyberNanoPay pitch.
Uses edge-tts for Chinese TTS, ffmpeg to merge with video.
"""
import asyncio
import edge_tts
import subprocess
import os
import json

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
VIDEO_IN = os.path.join(SCRIPT_DIR, "video.mp4")
AUDIO_OUT = os.path.join(SCRIPT_DIR, "narration.mp3")
VIDEO_OUT = os.path.join(SCRIPT_DIR, "video-cn.mp4")

# Narration segments timed to the ~40s video
# Video timeline:
#   0-10s:  Dashboard overview (TEE attestation, protocol stats, demo UI)
#   10-14s: Click "Run Full Demo", generating keys
#   14-20s: Steps running (deposit, sign & pay)
#   20-28s: All 5 steps done, log shows 10/10 payments, receipt
#   28-35s: TEE receipt details, architecture diagram
#   35-41s: Final view
NARRATION = """大家好，我是 Kenny。CyberNanoPay 让 AI Agent 在 TON 上零 gas 微支付。
Agent 每天调用上千次 API，链上 gas 太贵，传统支付不支持机器对机器。
我们的方案：链下签名零 gas，Phala TEE 验证聚合，TON 链上批量结算。
看 Demo：Agent 生成密钥，存入 USDT，发送十笔微支付，链下签名，毫秒确认。
每笔生成 TEE 签名收据，带 Merkle 证明，可独立验证。
架构是 Agent 签名，TEE 验证，合约结算，Telegram 人机审批。
CyberNanoPay 让 TON 成为 AI Agent 经济的结算层。谢谢。"""

VOICE = "zh-CN-YunyangNeural"
RATE = "+15%"  # faster to fit ~40s


async def generate_audio():
    print(f"Generating TTS with voice: {VOICE}")
    communicate = edge_tts.Communicate(NARRATION.strip(), VOICE, rate=RATE)
    await communicate.save(AUDIO_OUT)
    print(f"Audio saved: {AUDIO_OUT}")

    # Check audio duration
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json",
         "-show_format", AUDIO_OUT],
        capture_output=True, text=True
    )
    info = json.loads(result.stdout)
    duration = float(info["format"]["duration"])
    print(f"Audio duration: {duration:.1f}s")
    return duration


def merge_video(audio_duration):
    print("Merging audio with video...")

    # Get video duration
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json",
         "-show_format", VIDEO_IN],
        capture_output=True, text=True
    )
    video_duration = float(json.loads(result.stdout)["format"]["duration"])
    print(f"Video duration: {video_duration:.1f}s")

    if audio_duration > video_duration:
        # Audio longer than video: slow down video to match audio
        speed = video_duration / audio_duration
        print(f"Audio ({audio_duration:.1f}s) > Video ({video_duration:.1f}s)")
        print(f"Slowing video by {speed:.3f}x to match audio")
        subprocess.run([
            "ffmpeg", "-y",
            "-i", VIDEO_IN,
            "-i", AUDIO_OUT,
            "-filter:v", f"setpts={1/speed}*PTS",
            "-map", "0:v", "-map", "1:a",
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            VIDEO_OUT
        ], check=True)
    else:
        # Video longer or equal: just replace audio
        print("Replacing video audio with narration")
        subprocess.run([
            "ffmpeg", "-y",
            "-i", VIDEO_IN,
            "-i", AUDIO_OUT,
            "-map", "0:v", "-map", "1:a",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            VIDEO_OUT
        ], check=True)

    # Get output info
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json",
         "-show_format", VIDEO_OUT],
        capture_output=True, text=True
    )
    out_info = json.loads(result.stdout)
    out_duration = float(out_info["format"]["duration"])
    out_size = int(out_info["format"]["size"]) / 1024 / 1024
    print(f"\nOutput: {VIDEO_OUT}")
    print(f"Duration: {out_duration:.1f}s, Size: {out_size:.1f}MB")


async def main():
    audio_duration = await generate_audio()
    merge_video(audio_duration)
    print("\nDone!")


if __name__ == "__main__":
    asyncio.run(main())
