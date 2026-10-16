# CMakeLists.txt —— DSH on HarmonyOS 的 NAPI 宿主壳（T9）
#
# 构建方式（用 DevEco 自带的 NDK 工具链）：
#   cmake -S . -B build -G Ninja \
#     -DCMAKE_TOOLCHAIN_FILE=<NDK>/build/cmake/ohos.toolchain.cmake \
#     -DOHOS_ARCH=arm64-v8a
#   cmake --build build
#
# 在 hvigor 工程里则由 entry/build-profile.json5 的 externalNativeOptions 指定 path/arguments。
cmake_minimum_required(VERSION 3.5.0)
project(dsh_nodehost)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 常见告警当作硬错误，避免把问题带到设备上（可临时关掉排查）
add_compile_options(-Wall -Wextra -Wno-unused-parameter)

# ★ 关键：产物必须落到 <module>/libs/<abi>/，hvigor 才会把它打进 HAP 的 native libs 目录。
#   （只把 .so 编出来而放在 build/ 里，HAP 里是【没有 libs/】的——这是实测踩到的坑）
set(OUT_LIBS_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../libs/${OHOS_ARCH})
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${OUT_LIBS_DIR})
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${OUT_LIBS_DIR})
message(STATUS "native output dir = ${OUT_LIBS_DIR}")

add_library(node_ctl SHARED node_ctl.cpp)

target_link_libraries(node_ctl PUBLIC
    libace_napi.z.so      # NAPI（sysroot/usr/lib/<abi>/）
    libhilog_ndk.z.so     # 日志
)
