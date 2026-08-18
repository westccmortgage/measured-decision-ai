#include <ins_stitcher.h>
#include <condition_variable>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

int main(int argc, char** argv) {
  std::vector<std::string> inputs;
  std::string output;
  // The SDK resolves its AI weights from this directory and the vendor example
  // defaults it to ./models/, so the container places them beside the worker.
  std::string model_root_dir = "./models/";
  int width = 5760;
  int height = 2880;
  int64_t bitrate = 80000000;

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--input" && i + 1 < argc) inputs.emplace_back(argv[++i]);
    else if (arg == "--output" && i + 1 < argc) output = argv[++i];
    else if (arg == "--width" && i + 1 < argc) width = std::stoi(argv[++i]);
    else if (arg == "--height" && i + 1 < argc) height = std::stoi(argv[++i]);
    else if (arg == "--bitrate" && i + 1 < argc) bitrate = std::stoll(argv[++i]);
    else if (arg == "--models" && i + 1 < argc) model_root_dir = argv[++i];
  }

  if (inputs.empty() || output.empty() || width <= 0 || height <= 0 || width != height * 2) {
    std::cerr << "Usage: stitch360 --input lens00.insv --input lens10.insv --output master.mp4"
                 " [--width 5760 --height 2880 --bitrate 80000000 --models ./models/]\n";
    return 2;
  }

  // Both calls are mandatory and neither is implied by constructing a stitcher:
  // without InitEnv the SDK is not started, and without a model root the passes
  // that load weights fail at run time rather than at startup.
  ins::SetLogLevel(ins::InsLogLevel::ERR);
  ins::InitEnv();
  ins::SetModelFileRootDir(model_root_dir);

  std::mutex mutex;
  std::condition_variable condition;
  bool finished = false;
  bool failed = false;
  int sdk_error = 0;

  auto stitcher = std::make_shared<ins::VideoStitcher>();
  stitcher->SetInputPath(inputs);
  stitcher->SetOutputPath(output);
  stitcher->SetStitchType(ins::STITCH_TYPE::OPTFLOW);
  stitcher->EnableCuda(true);
  stitcher->EnableFlowState(true);
  stitcher->EnableDirectionLock(true);
  stitcher->EnableH265Encoder();
  stitcher->SetOutputSize(width, height);
  stitcher->SetOutputBitRate(bitrate);
  stitcher->SetStitchProgressCallback([&](int progress, int error) {
    std::cout << "{\"progress\":" << progress << ",\"sdk_error\":" << error << "}" << std::endl;
    if (progress >= 100) {
      std::lock_guard<std::mutex> lock(mutex);
      finished = true;
      condition.notify_one();
    }
  });
  stitcher->SetStitchStateCallback([&](int error, const char* message) {
    std::cerr << "MediaSDK error " << error << ": " << (message ? message : "unknown") << std::endl;
    std::lock_guard<std::mutex> lock(mutex);
    sdk_error = error;
    failed = true;
    condition.notify_one();
  });

  stitcher->StartStitch();
  std::unique_lock<std::mutex> lock(mutex);
  condition.wait(lock, [&] { return finished || failed; });
  return failed ? (sdk_error ? 10 : 11) : 0;
}
